/**
 * LLM history based chat for Enterprise AI.
 * 
 * Request params
 * 	id - The user ID
 *  org - User's Org
 *  session_id - The session ID for a previous session if this is a continuation
 *  prompt - The chat prompt
 *  aiappid - The brain ID
 *  auto_summary - Set to true to reduce session size but can cause response errors
 *  <anything else> - Used to expand the prompt, including user's queries
 * 
 * The Response is an object
 *  result - true or false
 *  reason - set to one of the reasons if result is false
 *  response - the AI response, as a plain text
 *  session_id - the session ID which can be used to ask backend to maintain sessions
 *  metadatas - the response document metadatas. typically metadata.referencelink points
 * 				to the exact document
 * 
 * (C) 2023 TekMonks. All rights reserved.
 */

const mustache = require("mustache");
const {Readable} = require("stream");
const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const NEURANET_CONSTANTS = LOGINAPP_CONSTANTS.ENV.NEURANETAPP_CONSTANTS;
const quota = require(`${NEURANET_CONSTANTS.LIBDIR}/quota.js`);
const aiapp = require(`${NEURANET_CONSTANTS.LIBDIR}/aiapp.js`);
const llmchat = require(`${NEURANET_CONSTANTS.LIBDIR}/llmchat.js`);
const textextractor = require(`${NEURANET_CONSTANTS.LIBDIR}/textextractor.js`);
const llmflowrunner = require(`${NEURANET_CONSTANTS.LIBDIR}/llmflowrunner.js`);
const neuranetutils = require(`${NEURANET_CONSTANTS.LIBDIR}/neuranetutils.js`);
const langdetector = require(`${NEURANET_CONSTANTS.THIRDPARTYDIR}/langdetector.js`);

const REASONS = llmflowrunner.REASONS, CHAT_MODEL_DEFAULT = "chat-knowledgebase-openai", 
    DEBUG_MODE = NEURANET_CONSTANTS.CONF.debug_mode, DEFAULT_MAX_MEMORY_TOKENS = 1000;

/**
 * Runs the LLM. 
 * 
 * @param {Object} params Request params documented below
 * 	                          id - The user ID
 *                            org - User's Org
 *                            session_id - The session ID for a previous session if this is a continuation
 *                            prompt - The chat prompt
 *                            question - The question asked
 * 							  files - Attached files to the question
 * 							  brainid - The brain ID
 * 							  auto_summary - Set to true to reduce session size but can cause response errors
 * 							  model - The chat model to use, with overrides
 * 							  documents - Documents to use for the chat
 * 							  matchers_for_reference_links - The matchers for reference links
 *                            <anything else> - Used to expand the prompt, including user's queries
 * @param {Object} _llmstepDefinition Not used.
 * 
 * @returns {Object} The Response is an object
 *  	                 result - true or false
 *  	                 reason - set to one of the reasons if result is false
 *  	                 response - the AI response, as a plain text
 *  	                 session_id - the session ID which can be used to ask backend to maintain sessions
 *  	                 metadatas - the response document metadatas. typically metadata.referencelink points
 * 					                 to the exact document
 */
exports.answer = async (params) => {
	const id = params.id, org = params.org, session_id = params.session_id, brainid = params.aiappid;

	LOG.debug(`Got LLM_History chat request from ID ${id} of org ${org}. Incoming params are ${JSON.stringify(params)}`);

	const aiappThis = await aiapp.getAIApp(id, org, brainid, true);
    if ((!aiappThis.disable_quota_checks) && (!(await quota.checkQuota(id, org, brainid)))) {
		const errMsg = `Disallowing the doc chat call, as the user ${id} of org ${org} is over their quota.`;
		LOG.error(errMsg); params.return_error(errMsg); return;
	}

	const chatsession = llmchat.getUsersChatSession(id, session_id).chatsession;
	const aiModelToUseForChat = params.model.name||CHAT_MODEL_DEFAULT, 
		aiModelObjectForChat = await aiapp.getAIModel(aiModelToUseForChat, params.model.model_overrides, 
			params.id, params.org, brainid);
	const aiModuleToUse = `${NEURANET_CONSTANTS.LIBDIR}/${aiModelObjectForChat.driver.module}`
	let aiLibrary; try{aiLibrary = serverutils.requireWithDebug(aiModuleToUse, DEBUG_MODE);} catch (err) {
		const errMsg = "Bad AI Library or model - "+aiModuleToUse+", error: "+err;
        LOG.error(errMsg); params.return_error(errMsg, REASONS.INTERNAL); return;
	}
	const finalSessionObject = chatsession.length ? await llmchat.trimSession(
		aiModelObjectForChat.max_memory_tokens||DEFAULT_MAX_MEMORY_TOKENS,
		llmchat.jsonifyContentsInThisSession(chatsession), aiModelObjectForChat, 
		aiModelObjectForChat.token_approximation_uplift, aiModelObjectForChat.tokenizer, aiLibrary) : [];
	if (finalSessionObject.length) finalSessionObject[finalSessionObject.length-1].last = true;

	const languageDetectedForQuestion =  langdetector.getISOLang(params.question)

	const validateDocumentsOrFiles = (fileOrDocArray) => fileOrDocArray && fileOrDocArray.length !=0;
	const documentResultsForPrompt = params.documents;	// if no documents found, short-circuit with no knowledge error
	if (!validateDocumentsOrFiles(documentResultsForPrompt) && !validateDocumentsOrFiles(params.files)) {
		const errMsg = "No knowledge of this topic."; LOG.error(errMsg); 
		params.return_error(errMsg, REASONS.NOKNOWLEDGE); return;
	}
	
	const documentsForPrompt = [], metadatasForResponse = []; 
	if(validateDocumentsOrFiles(documentResultsForPrompt)) for (const [i,documentResult] of documentResultsForPrompt.entries()) {
		documentsForPrompt.push({content: documentResult.text, document_index: i+1}); 
		const metadataThis = serverutils.clone(documentResult.metadata);
		if (params.matchers_for_reference_links && metadataThis[NEURANET_CONSTANTS.REFERENCELINK_METADATA_KEY]) 
				for (const matcher of params.matchers_for_reference_links) { 
			let reflink = metadataThis[NEURANET_CONSTANTS.REFERENCELINK_METADATA_KEY], match = reflink.match(new RegExp(matcher));
			if (match) metadataThis[NEURANET_CONSTANTS.REFERENCELINK_METADATA_KEY] = match.slice(1).join("/");
		}
		metadatasForResponse.push(metadataThis) 
	};
	let filesForPrompt = undefined; if (validateDocumentsOrFiles(params.files)) for (const file of params.files) {
		const textsteam = await textextractor.extractTextAsStreams(Readable.from(Buffer.from(file.bytes64, "base64")), file.filename);
		const text = await neuranetutils.readFullFile(textsteam, "utf8");
		if (text) {
			if (!filesForPrompt) filesForPrompt = []; 
			filesForPrompt.push({filename: file.filename, text}); 
			const metadataForReferenceThisFile = {}; 
			metadataForReferenceThisFile[NEURANET_CONSTANTS.REFERENCELINK_METADATA_KEY] = file.filename;
			metadatasForResponse.push(metadataForReferenceThisFile);
		}
	}
	const knowledgebasePromptTemplate =  params[`prompt_${languageDetectedForQuestion}`] || params.prompt;
	const knowledegebaseWithQuestion = mustache.render(
		knowledgebasePromptTemplate, {...params, documents: documentsForPrompt, files: filesForPrompt}).trim();

	const paramsChat = { id, org, maintain_session: true, session_id, model: aiModelObjectForChat,
        session: [{"role": aiModelObjectForChat.user_role, "content": knowledegebaseWithQuestion}],
		auto_chat_summary_enabled: params.auto_summary||false, raw_question: params.question, aiappid: brainid };
	const response = await llmchat.chat(paramsChat);

	return {...response, metadatas: metadatasForResponse};
}
