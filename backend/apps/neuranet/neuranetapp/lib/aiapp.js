/**
 * Deals with AI apps.
 * 
 * (C) 2023 TekMonks. All rights reserved.
 * License: See the enclosed LICENSE file.
 */

const yaml = require("yaml");
const fspromises = require("fs").promises;
const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const NEURANET_CONSTANTS = LOGINAPP_CONSTANTS.ENV.NEURANETAPP_CONSTANTS;
const aiutils = require(`${NEURANET_CONSTANTS.LIBDIR}/aiutils.js`);
const dblayer = require(`${NEURANET_CONSTANTS.LIBDIR}/dblayer.js`);
const brainhandler = require(`${NEURANET_CONSTANTS.LIBDIR}/brainhandler.js`);

const APP_CACHE = {}, FLOWSECTION_CACHE = {}, DEBUG_MODE = NEURANET_CONSTANTS.CONF.debug_mode;

exports.DEFAULT_ENTRY_FUNCTIONS = {llm_flow: "answer", pregen_flow: "generate"};
exports.AIAPP_STATUS = {PUBLISHED: "published", UNPUBLISHED: "unpublished"};

/**
 * Returns the flow object of the YAML file for the given ai application
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @param {string} flow_section The flow section name
 * @returns The flow object of the YAML file for the given ai application
 */
exports.getAIAppObject = async function(id, org, aiappid, flow_section) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const app = await exports.getAIApp(id, org, aiappid), flowCacheKey = `${id}_${org}_${aiappid}_${flow_section}`;

    if (!app[flow_section]) return [];

    if (typeof app[flow_section] === "string") {  // flow is in an external file
        if (FLOWSECTION_CACHE[flowCacheKey] && (!DEBUG_MODE)) return FLOWSECTION_CACHE[flowCacheKey];
        else FLOWSECTION_CACHE[flowCacheKey] = app[flow_section].toLowerCase().endsWith("yaml") ?
            yaml.parse(await fspromises.readFile(`${_getAppDir(id, org, aiappid)}/${app[flow_section]}`, "utf8")) :
            JSON.parse(await fspromises.readFile(`${_getAppDir(id, org, aiappid)}/${app[flow_section]}`, "utf8"));
        return FLOWSECTION_CACHE[flowCacheKey];
    } else return app[flow_section];  // flow is inline
}

/**
 * Returns the LLM gen object (llm_flow) of the YAML file for the given ai application
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns The LLM gen object (llm_flow) of the YAML file for the given ai application
 */
exports.getLLMGenObject = (id, org, aiappid) => exports.getAIAppObject(id, org, aiappid, "llm_flow");

/**
 * Returns the pre gen object (pregen_flow) of the YAML file for the given ai application
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns The pre-gen (pregen_flow) object of the YAML file for the given ai application
 */
exports.getPregenObject = (id, org, aiappid) => exports.getAIAppObject(id, org, aiappid, "pregen_flow");

/**
 * Returns the AI app object itself - the overall AI app object.
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @param {boolean} forcecache Force use of cache 
 * @returns The AI app object itself - the overall AI app object.
 */
exports.getAIApp = async function(id, org, aiappid, forcecache) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const appCacheKey = `${org}_${aiappid}`;
    if ((forcecache || (!DEBUG_MODE)) && APP_CACHE[appCacheKey]) return APP_CACHE[appCacheKey];

    try {
        const appFile = exports.getAppFile(id, org, aiappid), appFileYaml = await fspromises.readFile(appFile, "utf8"),
            app = yaml.parse(appFileYaml); APP_CACHE[appCacheKey] = app;
        return APP_CACHE[appCacheKey];
    } catch (err) { // app file parsing issue
        if (!NEURANET_CONSTANTS.CONF.dynamic_aiapps) {  // dynamic apps not supported, we can't do anything else
            LOG.error(`AI app parsing error for ID ${aiappid} for org ${org}.`);
            throw err; 
        }

        // dynamic app support will allow for partitioned DBs with app IDs but using default YAML as the app definition
        LOG.warn(`Using dynamic app for app ID ${aiappid} for org ${org}, as static app for this ID not found.`);
        const aiappidDefaultForOrg = await exports.getDefaultAppIDForOrg(org), 
            appFileDefaultForOrg = exports.getAppFile(id, org, aiappidDefaultForOrg),
            appDefaultYamlForOrg = await fspromises.readFile(appFileDefaultForOrg, "utf8");
        const appDefaultForOrg = yaml.parse(appDefaultYamlForOrg); appDefaultForOrg.id = aiappid;
        return appDefaultForOrg;
    }
}

/**
 * Returns the default AI app
 * @return {object} The default AI app object
 */
exports.getDefaultAIApp = async _ => {
    const aiappidDefault = exports.getDefaultAppIDForOrg(org), 
        appFileDefault = exports.getAppFile(NEURANET_CONSTANTS.DEFAULT_ID, NEURANET_CONSTANTS.DEFAULT_ORG, aiappidDefault),
        appDefaultYaml = await fspromises.readFile(appFileDefault, "utf8");
    const app = yaml.parse(appDefaultYaml);
    return app;
}

/**
 * Returns AI model taking into account app's global overrides.
 * @param {string} model_name The model name
 * @param {object} model_overrides The overrides for this model, or undefined if none
 * @param {string} id The ID - if not provided then global overrides don't take effect
 * @param {string} org The org - if not provided then global overrides don't take effect
 * @param {string} aiappid The AI app ID - if not provided then global overrides don't take effect
 * @returns The AI model taking into account app's global overrides.
 */
exports.getAIModel = async function(model_name, model_overrides={}, id, org, aiappid) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const aiapp = (id && org && aiappid) ? await exports.getAIApp(id, org, aiappid) : {global_models: []};
    let globalOverrides = {}; for (const globalModel of aiapp.global_models) if (globalModel.name == model_name) {
        globalOverrides = globalModel.model_overrides; break; }
    const final_overrides = {...globalOverrides, ...model_overrides};
    return await aiutils.getAIModel(model_name, final_overrides);
}

/**
 * Returns the JS module, whether plugin or loaded from app, for YAML command modules
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @param {string} command The command name
 * @return The JS module, whether plugin or loaded from app, for YAML command modules
 */
exports.getCommandModule = async function(id, org, aiappid, command) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const aiapp = await exports.getAIApp(id, org, aiappid);
    if (aiapp.modules?.[command]) return require(`${exports.getAppDir(id, org, aiappid)}/${aiapp.modules[command]}`);
    else return await NEURANET_CONSTANTS.getPlugin(command);    // if it is not part of the app then must be built-in
}

/**
 * Returns AI application directory.
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns AI application directory.
 */
exports.getAppDir = (id, org, aiappid) => exports.isThisDefaultOrgsDefaultApp(id, org, aiappid) ?
    `${NEURANET_CONSTANTS.AIAPPDIR}/${NEURANET_CONSTANTS.DEFAULT_ORG}/${aiappid}` : `${NEURANET_CONSTANTS.AIAPPDIR}/${org}/${aiappid}`;
    
/**
 * Returns the list of all AI apps for the given org.
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {boolean} onlyPublished If true then only published apps are returned
 * @returns Array of AI app objects for given org (complete YAML objects)
 */
exports.getAllAIAppsForOrg = async (id, org, onlyPublished) => {
    org = org.toLowerCase();
    const aiappsDB = await dblayer.getAllAIAppsForOrg(org, onlyPublished?exports.AIAPP_STATUS.PUBLISHED:undefined);
    const retAiAppObjects = []; for (const aiappThis of aiappsDB) {
        const aiappObject = await exports.getAIApp(id, org, aiappThis.aiappid);
        retAiAppObjects.push(aiappObject);
    }
    return retAiAppObjects;
}

/**
 * Initializes and adds the given AI app for the given org, but doesn't
 * publish it.
 * @param {string} aiappid The AI app ID
 * @param {string} label The AI app label for the interface section
 * @param {string} id The user ID
 * @param {string} org The org
 * @returns true on success or false on failure
 */
exports.initNewAIAppForOrg = async function(aiappid, label, id, org) {    
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const defaultAppDir = exports.getAppDir(NEURANET_CONSTANTS.DEFAULT_ID, NEURANET_CONSTANTS.DEFAULT_ORG, 
        NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP), newAppDir = exports.getAppDir(id, org, aiappid);

    const logErrorExists = LOG.error(`AI app init failed for ${org} for AI app ${aiappid} due to existing app.`);
    try {await fspromises.access(newAppDir); logErrorExists(); return false;} catch (err) { // don't overwrite existing apps
        if (err.code !== "ENOENT") {logErrorExists(); return false;} };

    try {
        let result = true; serverutils.walkFolder(defaultAppDir, async (fullpath, _stats, relativePath) => {
            if (!result) return;    // already failed, no point wasting time walking further
            if (relativePath.toLowerCase().endsWith(".yaml")) relativePath = relativePath.replace(NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP, aiappid);    // replace app ID in path
            let fileContents = await fspromises.readFile(fullpath, "utf8");
            if (fullpath.toLowerCase().endsWith(".yaml")) fileContents = fileContents.replace(    // fix app IDs and labels
                NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP, aiappid).replace(
                    `label: ${NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP_LABEL}`, `label: ${label}`); 
            const fileBuffer = Buffer.from(fileContents, "utf8");
            const fileindexer = require(`${NEURANET_CONSTANTS.LIBDIR}/fileindexer.js`); // moving this to the top causes circular dependency between aidbfs (which needs aiapp) and fileindexer.js (which needs aidbfs)
            result = await fileindexer.addFileToCMSRepository(id, org,  // app dir is CMS managed so this is needed
                fileBuffer, relativePath, `AI app file for ${aiappid}`, brainhandler.createExtraInfo(
                    id, org, aiappid, undefined, NEURANET_CONSTANTS.AIAPPMODES.EDIT), true);    // no ai event is true as we don't add this file to the AI
        });
        if (result) {
            const aidbfs = require(`${NEURANET_CONSTANTS.LIBDIR}/aidbfs.js`);   // avoid cyclic requires
            const aidbRoot = `${NEURANET_CONSTANTS.AIDBPATH}`;
            const appdbFolderPath = `${aidbRoot}/${aidbfs.getDBID(id, org, aiappid)}`;  // create ai app's DB dir for Ai DBs
            await serverutils.createDirectory(appdbFolderPath);
            result = await dblayer.addOrUpdateAIAppForOrg(org, aiappid, exports.AIAPP_STATUS.UNPUBLISHED);
        } else {
            LOG.error(`DB update for AI app ${aiappid} for org ${org} failed.`);
            try {await serverutils.rmrf(newAppDir);} catch (err) {LOG.error(`Error ${err} cleaning up ${newAppDir} for org ${org}.`);}
        }
        return result;
    } catch (err) {
        LOG.error(`AI app init failed for ${org} for AI app ${aiappid} due to error ${err}`);
        return false;
    }
}


/**
 * Deletes the given AI app for the given org.
 * @param {string} aiappid The AI app ID
 * @param {string} id The user ID
 * @param {string} org The org
 * @returns true on success or false on failure
 */
exports.deleteAIAppForOrg = async function (aiappid, id, org) {
    const appDir = exports.getAppDir(id, org, aiappid);
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    const aidbfs = require(`${NEURANET_CONSTANTS.LIBDIR}/aidbfs.js`);   // avoid cyclic requires
    const aidbRoot = `${NEURANET_CONSTANTS.AIDBPATH}`;
    const appdbArchiveDirPath = `${aidbRoot}/archive`, appdbFolderPath = `${aidbRoot}/${aidbfs.getDBID(id, org, aiappid)}`;  // save uploaded data
    const zipFilePath = `${appdbArchiveDirPath}/${aiappid}.zip`;
    let result; 
    try {
        await serverutils.createDirectory(appdbArchiveDirPath);
        await serverutils.zipFolder(appdbFolderPath, zipFilePath);
        await serverutils.rmrf(appdbFolderPath);    // delete trained DBs
        result = await serverutils.rmrf(appDir);    // delete app itself
    } catch (err) {
        LOG.error(`Error deleting AI app for org ${org}: ${err.message}`);
        return false;
    }
    if (!result) {
        LOG.error(`Error deleting hosting folder for app ${aiappid} for org ${org}.`);
        return false;
    } else {
        return await dblayer.deleteAIAppforOrg(org, aiappid);
    }
}

/**
 * Publishes (but doesn't add) the given AI app for the given org.
 * @param {string} aiappid The AI app ID
 * @param {string} org The org
 * @returns true on success or false on failure
 */
exports.publishAIAppForOrg = async function(aiappid, org) {  
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();
    return await dblayer.addOrUpdateAIAppForOrg(org, aiappid, exports.AIAPP_STATUS.PUBLISHED);
}

/**
 * Unpublishes (but doesn't delete) the given AI app for the given org.
 * @param {string} aiappid The AI app ID
 * @param {string} org The org
 * @returns true on success or false on failure
 */
exports.unpublishAIAppForOrg = async function(aiappid, org) {
    aiappid = aiappid.toLowerCase(); org = org.toLowerCase();  
    return await dblayer.addOrUpdateAIAppForOrg(org, aiappid, exports.AIAPP_STATUS.UNPUBLISHED);
}

/**
 * Returns the default app ID for an org
 * @param {string} org The org whose default AI app ID is needed
 * @returns The default app ID for an org
 */
exports.getDefaultAppIDForOrg = async function (org) {
    const orgSettings = await dblayer.getOrgSettings(org);
    return orgSettings.defaultapp || NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP;
}

/**
 * Sets the default app ID for an org
 * @param {string} org The org whose default AI app ID is to be set
 * @param {string} aiappid The new default app ID
 * @returns true on success and false or undefined on errors
 */
exports.setDefaultAppIDForOrg = async function (org, aiappid) {
    const orgSettings = await dblayer.getOrgSettings(org);
    orgSettings.defaultapp = aiappid;
    return dblayer.setOrgSettings(org, orgSettings);
}

/**
 * Returns true if the given id, org and aiappid belong instead to the default org and default app
 * @param {string} _id The ID (not used)
 * @param {string} _org The org (not used)
 * @param {string} aiappid The app ID to be tested 
 * @returns true if the given id, org and aiappid belong instead to the default org and default app
 */
exports.isThisDefaultOrgsDefaultApp = (_id, _org, aiappid) => aiappid == NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP;

/**
 * Returns the app ID to use for a given request.
 * @param {string} id The ID 
 * @param {string} org The org 
 * @param {*} extraInfo The associated extraInfo object
 * @returns The app ID to use for a given request.
 */
exports.getAppID = async function(idIn, orgIn, extraInfo) {
    const {id, org, aiappid} = brainhandler.unmarshallExtraInfo(extraInfo);

    // everything is ok so use what is requested
    if (extraInfo && (id == idIn) && (org == orgIn) && (aiappid)) return aiappid;    

    // if this org has a default app then use that if missing
    if (orgIn) {
        const orgSettings = await dblayer.getOrgSettings(orgIn);
        if (orgSettings.defaultapp) return orgSettings.defaultapp; 
    } 

    // finally failover to default org's default AI app
    return NEURANET_CONSTANTS.DEFAULT_ORG_DEFAULT_AIAPP; 
}

/**
 * Returns AI application file.
 * @param {string} id The user ID
 * @param {string} org The org
 * @param {string} aiappid The AI app ID
 * @returns AI application file.
 */
exports.getAppFile = (id, org, aiappid) => `${exports.getAppDir(id, org, aiappid)}/${aiappid}.yaml`;
