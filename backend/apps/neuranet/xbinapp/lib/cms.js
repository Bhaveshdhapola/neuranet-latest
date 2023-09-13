/** 
 * (C) 2020 TekMonks. All rights reserved.
 */
const fs = require("fs");
const path = require("path");
const fspromises = fs.promises;
const utils = require(`${CONSTANTS.LIBDIR}/utils.js`);
const XBIN_CONSTANTS = LOGINAPP_CONSTANTS.ENV.XBIN_CONSTANTS;
const login = require(`${LOGINAPP_CONSTANTS.API_DIR}/login.js`);
const register = require(`${LOGINAPP_CONSTANTS.API_DIR}/register.js`);
const updateuser = require(`${LOGINAPP_CONSTANTS.API_DIR}/updateuser.js`);
const loginappAPIKeyChecker = require(`${LOGINAPP_CONSTANTS.LIB_DIR}/loginappAPIKeyChecker.js`);

const DEFAULT_MAX_PATH_LENGTH = 50;

exports.init = _ => {
	updateuser.addIDChangeListener(async (oldID, newID, org) => {	// ID changes listener
		const oldPath = _getPathForIDAndOrg(oldID, org), newPath = _getPathForIDAndOrg(newID, org);
		try {
			if (!await utils.rmrf(newPath)) throw `Can't access or delete path ${newPath}`;	// remove existing newPath folder, if it exists, as this ID is taking it over
			await fspromises.rename(oldPath, newPath); 
			LOG.info(`Renamed home folder for ID ${oldID} who is changing their ID to new ID ${newID} from ${oldPath} to ${newPath}.`); return true;
		} catch (err) {
			LOG.error(`Error renaming home folder for ID ${oldID} who is changing their ID to new ID ${newID}. Error is ${err}.`);
			return false;
		}
	})

	register.addNewUserListener(`${XBIN_CONSTANTS.LIB_DIR}/cms.js`, "initXbinPath");// ID registration listener
}

/**
 * @param {object} headersOrLoginIDAndOrg HTTP request headers or {xbin_id, xbin_org} object
 * @returns The CMS root for this user.
 */
exports.getCMSRoot = async function(headersOrLoginIDAndOrg) {
	const headersOrLoginIDAndOrgIsHeaders = !(headersOrLoginIDAndOrg.xbin_org &&  headersOrLoginIDAndOrg.xbin_id);
	const loginID = headersOrLoginIDAndOrgIsHeaders ? login.getID(headersOrLoginIDAndOrg) : headersOrLoginIDAndOrg.xbin_id; 
	if (!loginID) throw "No login for CMS root"; 
	const org = headersOrLoginIDAndOrgIsHeaders ? (login.getOrg(headersOrLoginIDAndOrg)||"unknown") : headersOrLoginIDAndOrg.xbin_org;
	const cmsRootToReturn = _getPathForIDAndOrg(loginID, org);
	try { await fspromises.access(cmsRootToReturn, fs.F_OK); } catch (err) { await fspromises.mkdir(cmsRootToReturn, {recursive: true}); }
	LOG.info(`Returning CMS home as ${cmsRootToReturn} for id ${loginID} of org ${org}.`);
	return cmsRootToReturn;
}

exports.getCMSRootRelativePath = async function(headersOrLoginIDAndOrg, fullpath, dontencode) {
	const cmsroot = await exports.getCMSRoot(headersOrLoginIDAndOrg);
	const relativePath = path.relative(cmsroot, fullpath).replaceAll("\\", "/");
	return relativePath;
}

exports.getFullPath = async function(headersOrLoginIDAndOrg, cmsPath) {
	const cmsroot = await exports.getCMSRoot(headersOrLoginIDAndOrg);
	const fullpath = path.resolve(`${cmsroot}/${cmsPath}`);
	return fullpath;
}

exports.initXbinPath = async (result) => {
	const home = _getPathForIDAndOrg(result.id, result.org);
	try {await utils.rmrf(home); return true;} catch(err) {
			LOG.error(`Can't init the home folder for id ${result.id} for org ${result.org} as can't access or delete path ${home}. The error is ${err}.`);
			return false;
	}
}

exports.getID = headersOrLoginIDAndOrg => headersOrLoginIDAndOrg.xbin_id || login.getID(headersOrLoginIDAndOrg);

exports.getOrg = headersOrLoginIDAndOrg => headersOrLoginIDAndOrg.xbin_org || login.getOrg(headersOrLoginIDAndOrg);

exports.isSecure = async (headersOrHeadersAndOrg, path) => {	// add domain check here to ensure ID and org domains are ok
	const isKeySecure = headersOrHeadersAndOrg.xbin_org && headersOrHeadersAndOrg.headers ? 
		await loginappAPIKeyChecker.isAPIKeySecure(headersOrHeadersAndOrg.headers, headersOrHeadersAndOrg.xbin_org) : true;
	return isKeySecure && XBIN_CONSTANTS.isSubdirectory(path, await this.getCMSRoot(headersOrHeadersAndOrg));
}

const _getPathForIDAndOrg = (id, org) => `${XBIN_CONSTANTS.CONF.CMS_ROOT}/${_convertToPathFriendlyString(org.toLowerCase())}/${_convertToPathFriendlyString(id.toLowerCase())}`;

const _convertToPathFriendlyString = (s, maxPathLength=DEFAULT_MAX_PATH_LENGTH) => {
	let tentativeFilepath = encodeURIComponent(s);
	if (tentativeFilepath.endsWith(".")) tentativeFilepath = tentativeFilepath.substring(0,finalPath.length-1)+"%2E";
		
	if (tentativeFilepath.length > maxPathLength) {
		tentativeFilepath = tentativeFilepath + "." + Date.now();
		tentativeFilepath = tentativeFilepath.substring(tentativeFilepath.length-maxPathLength);
	}
	
	return tentativeFilepath;
}
