/** 
 * Shows how to embed an app inside loginapp.
 * 
 * (C) 2023 TekMonks. All rights reserved.
 * License: See enclosed LICENSE file.
 */

import {i18n} from "/framework/js/i18n.mjs";
import {util} from "/framework/js/util.mjs";
import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";

const MODULE_PATH = util.getModulePath(import.meta), 
    MAIN_HTML = util.resolveURL(`${APP_CONSTANTS.EMBEDDED_APP_PATH}/main.html`);

let loginappMain;

const main = async (data, mainLoginAppModule) => {
    window.monkshu_env.apps[APP_CONSTANTS.EMBEDDED_APP_NAME] = {main: neuranetapp};
    loginappMain = mainLoginAppModule; loginappMain.addGoHomeListener(gohome);
    APP_CONSTANTS.VIEWS_PATH = util.resolveURL(`${APP_CONSTANTS.EMBEDDED_APP_PATH}/views`);
    await _createdata(data); 
    data.maincontent = await router.loadHTML(MAIN_HTML, {...data}); 
}

async function _createdata(data) {   
    let viewPath, views; delete data.showhome; delete data.shownotifications;
    const appsAllowed = (session.get(APP_CONSTANTS.LOGIN_RESPONSE))?.apps||[];
    if (!session.get(APP_CONSTANTS.FORCE_LOAD_VIEW)) {
        const interfaceForView = appsAllowed.length == 1 ? appsAllowed[0].interface.type.toString() : APP_CONSTANTS.VIEW_CHOOSER;
        viewPath = `${APP_CONSTANTS.VIEWS_PATH}/${interfaceForView}`;
        views = []; for (const app of appsAllowed) if (app.interface != APP_CONSTANTS.VIEW_CHOOSER) views.push(  // views we can choose from
            {viewicon: `${APP_CONSTANTS.VIEWS_PATH}/${app.interface.type.toString()}/img/icon.svg`, 
                viewlabel: await i18n.get(`ViewLabel_${app.interface.type.toString()}`), viewname: app});
    } else {
        if (appsAllowed.length > 1) data.showhome = true;
        viewPath = `${APP_CONSTANTS.VIEWS_PATH}/${session.get(APP_CONSTANTS.FORCE_LOAD_VIEW)}`;
    }

    const viewURL = `${viewPath}/main.html`, viewMainMJS = `${viewPath}/js/main.mjs`;
    data.viewpath = viewPath; 
    try { const viewMain = await import(viewMainMJS); await viewMain.main.initView(data, neuranetapp); }    // init the view before loading it
    catch (err) { LOG.error(`Error in initializing view ${viewPath}.`); }
    data.viewcontent = await router.loadHTML(viewURL, {...data, views}); 
}

const gohome = _ => session.remove(APP_CONSTANTS.FORCE_LOAD_VIEW);

async function openView(viewname) {
    session.set(APP_CONSTANTS.FORCE_LOAD_VIEW, viewname);
    const {loginmanager} = await import (`${APP_CONSTANTS.LOGINFRAMEWORK_LIB_PATH}/loginmanager.mjs`);
    loginmanager.addLogoutListener(`${MODULE_PATH}/neuranetapp.mjs`, "neuranetapp", "onlogout");

    router.navigate(APP_CONSTANTS.MAIN_HTML);
}

function onlogout() {session.remove(APP_CONSTANTS.FORCE_LOAD_VIEW);}

const showMessage = message => loginappMain.showMessage(message);

const showError = error => {LOG.error(error); showMessage(error);}

export const neuranetapp = {main, openView, gohome, onlogout, showMessage, showError};