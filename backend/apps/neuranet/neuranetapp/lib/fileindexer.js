/**
 * Will index files including XBin documents in and out of the AI databases.
 * This should be the only class used for ingestion, except direct file operations
 * to XBin via XBin REST or JS APIs.
 * 
 * Bridge between drive documents including XBin and Neuranet knowledgebases.
 * 
 * (C) 2023 Tekmonks Corp. All rights reserved.
 * License: See enclosed LICENSE file.
 */

const XBIN_CONSTANTS = LOGINAPP_CONSTANTS.ENV.XBIN_CONSTANTS;
const NEURANET_CONSTANTS = LOGINAPP_CONSTANTS.ENV.NEURANETAPP_CONSTANTS;

const fs = require("fs");
const path = require("path");
const mustache = require("mustache");
const cms = require(`${XBIN_CONSTANTS.LIB_DIR}/cms.js`);
const serverutils = require(`${CONSTANTS.LIBDIR}/utils.js`)
const blackboard = require(`${CONSTANTS.LIBDIR}/blackboard.js`);
const aidbfs = require(`${NEURANET_CONSTANTS.LIBDIR}/aidbfs.js`);
const uploadfile = require(`${XBIN_CONSTANTS.API_DIR}/uploadfile.js`);
const deletefile = require(`${XBIN_CONSTANTS.API_DIR}/deletefile.js`);
const renamefile = require(`${XBIN_CONSTANTS.API_DIR}/renamefile.js`);
const downloadfile = require(`${XBIN_CONSTANTS.API_DIR}/downloadfile.js`);
const brainhandler = require(`${NEURANET_CONSTANTS.LIBDIR}/brainhandler.js`);
const neuranetutils = require(`${NEURANET_CONSTANTS.LIBDIR}/neuranetutils.js`);

let conf;
const DEFAULT_MINIMIMUM_SUCCESS_PERCENT = 0.5;

exports.initSync = _ => {
    conf = require(`${NEURANET_CONSTANTS.CONFDIR}/fileindexer.json`); 
    confRendered = mustache.render(JSON.stringify(conf), {APPROOT: NEURANET_CONSTANTS.APPROOT.split(path.sep).join(path.posix.sep)}); 
    conf = JSON.parse(confRendered);
    if (!conf.enabled) return;  // file indexer is disabled
    
    blackboard.subscribe(XBIN_CONSTANTS.XBINEVENT, message => _handleFileEvent(message));
    blackboard.subscribe(NEURANET_CONSTANTS.NEURANETEVENT, message => _handleFileEvent(message));
    _initPluginsSync(); 
}

async function _handleFileEvent(message) {
    const awaitPromisePublishFileEvent = async (promise, fullpath, type, id, org, extraInfo) => {  // this is mostly to inform listeners about file being processed events
        const cmspath = await cms.getCMSRootRelativePath({xbin_id: id, xbin_org: org}, fullpath, extraInfo);
        // we have started processing a file
        blackboard.publish(NEURANET_CONSTANTS.NEURANETEVENT, {type: NEURANET_CONSTANTS.EVENTS.AIDB_FILE_PROCESSING, 
            result: true, subtype: type, id, org, path: fullpath, cmspath, extraInfo});
        const result = await promise;   // wait for it to complete
        // we have finished processing this file
        blackboard.publish(NEURANET_CONSTANTS.NEURANETEVENT, {type: NEURANET_CONSTANTS.EVENTS.AIDB_FILE_PROCESSED, 
            path: fullpath, result: result?result.result:false, subtype: type, id, org, cmspath, extraInfo});
    }

    // only the testing classes currently use NEURANET_CONSTANTS.EVENTS.* as they directly upload to the
    // Neuranet drive instead of CMS
    const _isNeuranetFileCreatedEvent = message => message.type == XBIN_CONSTANTS.EVENTS.FILE_CREATED ||
        message.type == NEURANET_CONSTANTS.EVENTS.FILE_CREATED,
        _isNeuranetFileDeletedEvent = message => message.type == XBIN_CONSTANTS.EVENTS.FILE_DELETED ||
            message.type == NEURANET_CONSTANTS.EVENTS.FILE_DELETED,
        _isNeuranetFileRenamedEvent = message => message.type == XBIN_CONSTANTS.EVENTS.FILE_RENAMED ||
            message.type == NEURANET_CONSTANTS.EVENTS.FILE_RENAMED,
        _isNeuranetFileModifiedEvent = message => message.type == XBIN_CONSTANTS.EVENTS.FILE_MODIFIED ||
            message.type == NEURANET_CONSTANTS.EVENTS.FILE_MODIFIED;

    if (_isNeuranetFileCreatedEvent(message) && (!message.isDirectory)) 
        awaitPromisePublishFileEvent(_ingestfile(path.resolve(message.path), message.id, message.org, message.isxbin, message.lang, message.extraInfo), 
            message.path, NEURANET_CONSTANTS.FILEINDEXER_FILE_PROCESSED_EVENT_TYPES.INGESTED, message.id, message.org, message.extraInfo);
    else if (_isNeuranetFileDeletedEvent(message) && (!message.isDirectory)) 
        awaitPromisePublishFileEvent(_uningestfile(path.resolve(message.path), message.id, message.org, message.isxbin, message.extraInfo), 
            message.path, NEURANET_CONSTANTS.FILEINDEXER_FILE_PROCESSED_EVENT_TYPES.UNINGESTED, message.id, message.org, message.extraInfo);
    else if (_isNeuranetFileRenamedEvent(message) && (!message.isDirectory)) 
        awaitPromisePublishFileEvent(_renamefile(path.resolve(message.from), path.resolve(message.to), message.id, 
            message.org, message.isxbin, message.extraInfo), message.to, NEURANET_CONSTANTS.FILEINDEXER_FILE_PROCESSED_EVENT_TYPES.RENAMED, message.id, 
            message.org, message.extraInfo);
    else if (_isNeuranetFileModifiedEvent(message) && (!message.isDirectory)) {
        await _uningestfile(path.resolve(message.path), message.id, message.org, message.isxbin, message.extraInfo);
        awaitPromisePublishFileEvent(_ingestfile(path.resolve(message.path), message.id, message.org, message.isxbin, message.lang, message.extraInfo), 
            message.path, NEURANET_CONSTANTS.FILEINDEXER_FILE_PROCESSED_EVENT_TYPES.MODIFIED, message.id, message.org, message.extraInfo);
    }
}

async function _ingestfile(pathIn, id, org, isxbin, lang, extraInfo) {
    const cmspath = isxbin ? await cms.getCMSRootRelativePath({xbin_id: id, xbin_org: org}, pathIn, extraInfo) : pathIn;
    const indexer = _getFileIndexer(pathIn, isxbin, id, org, cmspath, extraInfo, lang), 
        filePluginResult = await _searchForFilePlugin(indexer);
    if (filePluginResult.plugin) return {result: await filePluginResult.plugin.ingest(indexer)};
    if (filePluginResult.error) return {result: false, cause: "Plugin validation failed."}
    else {const result = await indexer.addFile(null, cmspath, lang, null, false, true); await indexer.end(); return result;}
}

async function _uningestfile(pathIn, id, org, isxbin, extraInfo) {
    const cmspath = isxbin ? await cms.getCMSRootRelativePath({xbin_id: id, xbin_org: org}, pathIn, extraInfo) : pathIn;
    const indexer = _getFileIndexer(pathIn, isxbin, id, org, cmspath, extraInfo), 
        filePluginResult = await _searchForFilePlugin(indexer);
    if (filePluginResult.plugin) return {result: await filePluginResult.plugin.uningest(indexer)};
    if (filePluginResult.error) return {result: false, cause: "Plugin validation failed."}
    else {const result = await indexer.removeFile(cmspath, false, true); await indexer.end(); return result;}
}

async function _renamefile(from, to, id, org, isxbin, extraInfo) {
    const cmspathFrom = isxbin ? await cms.getCMSRootRelativePath({xbin_id: id, xbin_org: org}, from, extraInfo) : from;
    const cmspathTo = isxbin ? await cms.getCMSRootRelativePath({xbin_id: id, xbin_org: org}, to, extraInfo) : to;
    const indexer = _getFileIndexer(from, isxbin, id, org, cmspathFrom, extraInfo), filePluginResult = await _searchForFilePlugin(indexer);
    indexer.filepathTo = to; indexer.cmspathTo = cmspathTo;
    if (filePluginResult.plugin) return {result: await filePluginResult.plugin.rename(indexer)};
    if (filePluginResult.error) return {result: false, cause: "Plugin validation failed."}
    else {const result = await indexer.renameFile(cmspathFrom, cmspathTo, false, true); await indexer.end(); return result;}
}

async function _initPluginsSync() {
    const aiModelObject = await aidbfs.getAIModelForFiles();

    for (const file_plugin of aiModelObject.file_handling_plugins) {
        const pluginThis = NEURANET_CONSTANTS.getPlugin(file_plugin);
        if (pluginThis.initAsync) await pluginThis.initSync();
    }
}

async function _searchForFilePlugin(fileindexerForFile) {
    const aiModelObject = await aidbfs.getAIModelForFiles();

    for (const file_plugin of aiModelObject.file_handling_plugins) {
        const pluginThis = NEURANET_CONSTANTS.getPlugin(file_plugin);
        try {if (await pluginThis.canHandle(fileindexerForFile)) return {plugin: pluginThis, result: true, error: null};}
        catch (err) { LOG.error(`Plugin validation failed for ${file_plugin}. The error was ${err}`);
            return {error: err, result: false}}
    }

    return {error: null, result: false};
}

function _getFileIndexer(pathIn, isxbin, id, org, cmspath, extraInfo, lang) {
    return {
        filepath: pathIn, id, org, lang, minimum_success_percent: DEFAULT_MINIMIMUM_SUCCESS_PERCENT, cmspath,
        aiappid: brainhandler.getAppID(id, org, extraInfo),
        getContents: encoding => neuranetutils.readFullFile(isxbin?downloadfile.getReadStream(pathIn, extraInfo):fs.createReadStream(pathIn), encoding),
        getReadstream: _ => isxbin?downloadfile.getReadStream(pathIn, extraInfo):fs.createReadStream(pathIn),
        start: function(){},
        end: async function() { try {await aidbfs.rebuild(id, org, this.aiappid); await aidbfs.flush(id, org, this.aiappid); return true;} catch (err) {
            LOG.error(`Error ending AI databases. The error is ${err}`); return false;} },

        //addfile, removefile, renamefile - all follow the same high level logic
        addFile: async function(bufferOrStream, cmsPathThisFile, langFile, comment, runAsNewInstructions, noDiskOperation) {
            try {
                const fullPath = isxbin ? await cms.getFullPath({xbin_id: id, xbin_org: org}, cmsPathThisFile, extraInfo) : 
                    await _getNonCMSDrivePath(cmsPathThisFile, id, org), writeFileToDisk = !noDiskOperation;
                
                if (writeFileToDisk) {  // we need to write it to the disk, and if xbin don't publish another event (to avoid loops)
                    if (isxbin) {
                        const xbinUploadResult = await uploadfile.uploadFile(id, org, bufferOrStream, cmsPathThisFile, 
                            comment, extraInfo, true);
                        if (!xbinUploadResult?.result) throw new Error(`CMS upload failed for ${cmsPathThisFile}`);
                    } else await fs.promises.writeFile(fullPath, Buffer.isBuffer(bufferOrStream) ? 
                        bufferOrStream : neuranetutils.readFullFile(bufferOrStream));    // write to the disk
                }
                
                // if run as new instructions then publish a message which triggers file indexer to restart the 
                // whole process else ingest it directly into the DB as a regular file. it is a security risk
                // to setup runAsNewInstructions = true e.g. a website can have a .crawl file for Neuranet to
                // crawl bad data, so unless needed this should not be setup to true
                if (runAsNewInstructions) {
                    blackboard.publish(NEURANET_CONSTANTS.NEURANETEVENT, // ingest it into Neuranet
                        {type: NEURANET_CONSTANTS.EVENTS.FILE_CREATED, path: fullPath, id, org, 
                            ip: serverutils.getLocalIPs()[0], extraInfo: extraInfo});
                    return CONSTANTS.TRUE_RESULT;
                } else {    // update AI databases
                    const aiDBIngestResult = await aidbfs.ingestfile(fullPath, cmsPathThisFile, id, org, this.aiappid, 
                        langFile, isxbin?_=>downloadfile.getReadStream(fullPath):undefined, true);  // update AI databases
                    if (aiDBIngestResult?.result) return CONSTANTS.TRUE_RESULT; else return CONSTANTS.FALSE_RESULT;
                }
            } catch (err) {
                LOG.error(`Error writing file ${cmsPathThisFile} for ID ${id} and org ${org} due to ${err}.`);
                return CONSTANTS.FALSE_RESULT;
            }
        },
        removeFile: async function(cmsPathFile, runAsNewInstructions, noDiskOperation) {
            try {
                const fullPath = isxbin ? await cms.getFullPath({xbin_id: id, xbin_org: org}, cmsPathFile, extraInfo) : 
                    await _getNonCMSDrivePath(cmsPathFile, id, org), writeFileToDisk = !noDiskOperation;

                // delete the file from the file system being used whether it is XBin or Neuranet's internal drive
                if (writeFileToDisk) {
                    if (isxbin) {
                        const xbinDeleteResult = await deletefile.deleteFile({xbin_id: id, xbin_org: org}, cmsPathFile, 
                            extraInfo, true);
                        if (!xbinDeleteResult?.result) throw new Error(`CMS delete failed for ${cmsPathFile}`);
                    } else await fs.promises.unlink(fullPath);    // delete from the Neuranet's internal disk
                }

                if (runAsNewInstructions) { // run as new instructions means skip and restart from Neuranet events
                    blackboard.publish(NEURANET_CONSTANTS.NEURANETEVENT, // remove it from the Neuranet via a new event
                        {type: NEURANET_CONSTANTS.EVENTS.FILE_DELETED, path: fullPath, id, org, 
                            ip: serverutils.getLocalIPs()[0], extraInfo: extraInfo});
                    return CONSTANTS.TRUE_RESULT;
                } else {    // delete from AI databases
                    const aiDBUningestResult = await aidbfs.uningestfile(fullPath, id, org, this.aiappid);
                    if (aiDBUningestResult?.result) return CONSTANTS.TRUE_RESULT; else return CONSTANTS.FALSE_RESULT;
                }
            } catch (err) {
                LOG.error(`Error deleting file ${cmsPathFile} for ID ${id} and org ${org} due to ${err}.`);
                return CONSTANTS.FALSE_RESULT;
            }
        },
        renameFile: async function(cmsPathFrom, cmsPathTo, newcomment, runAsNewInstructions, noDiskOperation) {
            try {
                const fullPathFrom = isxbin ? await cms.getFullPath({xbin_id: id, xbin_org: org}, cmsPathFrom, extraInfo) : 
                    await _getNonCMSDrivePath(cmsPathFrom, id, org);
                const fullPathTo = isxbin ? await cms.getFullPath({xbin_id: id, xbin_org: org}, cmsPathTo, extraInfo) : 
                    await _getNonCMSDrivePath(cmsPathTo, id, org);
                const writeFileToDisk = !noDiskOperation;

                // rename the file from the file system being used whether it is XBin or Neuranet's internal drive
                if (writeFileToDisk) {
                    if (isxbin) {
                        const xbinRenameResult = await renamefile.renameFile({xbin_id: id, xbin_org: org}, cmsPathFrom, cmsPathTo, 
                            extraInfo, true);
                        if (!xbinRenameResult?.result) throw new Error(`CMS rename failed for ${cmsPathFrom}`);
                        if (newcomment) uploadfile.updateFileStats(fullPathTo, cmsPathTo, undefined, true, undefined, 
                            newcomment, extraInfo);
                    } else await fs.promises.rename(fullPathFrom, fullPathTo);    // rename on the Neuranet private disk
                } 

                if (runAsNewInstructions) { // publish the event and let it start again from the event
                    blackboard.publish(NEURANET_CONSTANTS.NEURANETEVENT, // rename it to the Neuranet
                        {type: NEURANET_CONSTANTS.EVENTS.FILE_RENAMED, from: fullPathFrom, to: fullPathTo, id, org, 
                            ip: serverutils.getLocalIPs()[0], extraInfo: extraInfo});
                    return CONSTANTS.TRUE_RESULT;
                } else {    // rename it in the AI databases
                    const aiDBRenameResult = await aidbfs.renamefile(fullPathFrom, fullPathTo, cmsPathTo, id, org, this.aiappid);
                    if (aiDBRenameResult?.result) return CONSTANTS.TRUE_RESULT; else return CONSTANTS.FALSE_RESULT;
                }
            } catch (err) {
                LOG.error(`Error renaming file ${cmsPathFrom} for ID ${id} and org ${org} due to ${err}.`);
                return CONSTANTS.FALSE_RESULT;
            }
        }
    }
}

async function _getNonCMSDrivePath(cmsPath, id, org) {
    const userRoot = path.resolve(`${conf.noncms_drive}/${org}/${id}`);
    const fullPath = path.resolve(userRoot+"/"+cmsPath), folderFullPath = path.dirname(fullPath);
    try {await fs.promises.stat(folderFullPath); return fullPath;} catch (err) {
        if (err.code == "ENOENT") {try {await fs.promises.mkdir(folderFullPath, {recursive: true}); return fullPath;} 
            catch (err) {throw err}} else throw err;
    }
}