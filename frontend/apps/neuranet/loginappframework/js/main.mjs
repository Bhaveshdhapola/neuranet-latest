/* 
 * (C) 2020 TekMonks. All rights reserved.
 * License: See enclosed license.txt file.
 */
import {i18n} from "/framework/js/i18n.mjs";
import {loginmanager} from "./loginmanager.mjs"
import {router} from "/framework/js/router.mjs";
import {session} from "/framework/js/session.mjs";
import {securityguard} from "/framework/js/securityguard.mjs";
import {apimanager as apiman} from "/framework/js/apimanager.mjs";

const dialog = _ => monkshu_env.components['dialog-box'], gohomeListeners = [];

function toggleMenu() {
    const imgElement = document.querySelector("span#menubutton > img"), menuIsOpen = imgElement.src.indexOf("menu.svg") != -1;
    const menuDiv = document.querySelector("div#menu");

    if (menuIsOpen) {    
        menuDiv.classList.add("visible"); menuDiv.style.maxHeight = menuDiv.scrollHeight+"px"; 
        imgElement.src = "./img/menu_close.svg";
    } else {
        menuDiv.classList.remove("visible"); menuDiv.style.maxHeight = 0; 
        imgElement.src = "./img/menu.svg";
    }
}

async function changePassword(_element) {
    dialog().showDialog(`${APP_CONSTANTS.DIALOGS_PATH}/changepass.html`, true, true, {}, "dialog", ["p1","p2"], async result=>{
        const done = await loginmanager.changepassword(session.get(APP_CONSTANTS.USERID), result.p1);
        if (!done) dialog().error("dialog", await i18n.get("PWCHANGEFAILED"));
        else { dialog().hideDialog("dialog"); showMessage(await i18n.get("PWCHANGED")); }
    });
}

async function showOTPQRCode(_element) {
    const id = session.get(APP_CONSTANTS.USERID).toString(); 
    const totpSec = await apiman.rest(APP_CONSTANTS.API_GETTOTPSEC, "GET", {id}, true, false); if (!totpSec || !totpSec.result) return;
    const qrcode = await _getTOTPQRCode(totpSec.totpsec);
    dialog().showDialog(`${APP_CONSTANTS.DIALOGS_PATH}/changephone.html`, true, true, {img:qrcode}, "dialog", ["otpcode"], async result => {
        const otpValidates = await apiman.rest(APP_CONSTANTS.API_VALIDATE_TOTP, "GET", {totpsec: totpSec.totpsec, otp:result.otpcode, id}, true, false);
        if (!otpValidates||!otpValidates.result) dialog().error("dialog", await i18n.get("PHONECHANGEFAILED"));
        else dialog().hideDialog("dialog");
    });
}

async function changeProfile(_element) {
    const sessionUser = loginmanager.getSessionUser();
    dialog().showDialog(`${APP_CONSTANTS.DIALOGS_PATH}/resetprofile.html`, true, true, sessionUser, "dialog", 
            ["name", "id", "org"], async result => {
        
        const updateResult = await loginmanager.registerOrUpdate(sessionUser.id, result.name, result.id, null, result.org);
        if (updateResult == loginmanager.ID_OK) dialog().hideDialog("dialog");
        else {
            let errorKey = "Internal"; switch (updateResult)
            {
                case loginmanager.ID_FAILED_EXISTS: errorKey = "Exists"; break;
                case loginmanager.ID_FAILED_OTP: errorKey = "OTP"; break;
                case loginmanager.ID_INTERNAL_ERROR: errorKey = "Internal"; break;
                case loginmanager.ID_DB_ERROR: errorKey = "Internal"; break;
                case loginmanager.ID_SECURITY_ERROR: errorKey = "SecurityError"; break;
                case loginmanager.ID_DOMAIN_ERROR: errorKey = "DomainError"; break;
                default: errorKey = "Internal"; break;
            }
            dialog().error("dialog", await i18n.get(`ProfileChangedFailed${errorKey}`));
        }
    });
}

function showLoginMessages() {
    const data = router.getCurrentPageData();
    if (data.showDialog) { showMessage(data.showDialog.message); delete data.showDialog; router.setCurrentPageData(data); }
}

const logoutClicked = _ => loginmanager.logout();

const interceptPageData = _ => router.addOnLoadPageData(APP_CONSTANTS.MAIN_HTML, async data => {   // set admin role if applicable
    if (securityguard.getCurrentRole()==APP_CONSTANTS.ADMIN_ROLE) data.admin = true; 
    
    const embeddedAppName = APP_CONSTANTS.EMBEDDED_APP_NAME?APP_CONSTANTS.EMBEDDED_APP_NAME.trim():undefined;
    if (embeddedAppName) try { 
        const embeddedappMainMJS = await import(`${APP_CONSTANTS.APP_PATH}/${embeddedAppName}/js/${embeddedAppName}.mjs`); 
        data = await embeddedappMainMJS[embeddedAppName].main(data, main); 
    } catch (err) { LOG.error(`Error in initializing embeded app ${embeddedAppName}, error is ${err}.`); }
});

async function gohome() {
    for (const listener of gohomeListeners) await listener();
    router.navigate(APP_CONSTANTS.MAIN_HTML);
}

async function showNotifications(action, event, bottom_menu) {
    const notifications = await eval(action);
    const context_menu = window.monkshu_env.components["context-menu"];
    context_menu.showMenu("contextmenumain", notifications, event.clientX, event.clientY, bottom_menu?5:10, bottom_menu?5:10, 
        null, true, bottom_menu, true);
}

const addGoHomeListener = listener => gohomeListeners.push(listener);

async function _getTOTPQRCode(key) {
	const title = await i18n.get("Title");
	await $$.require(`${APP_CONSTANTS.COMPONENTS_PATH}/register-box/3p/qrcode.min.js`);
	return new Promise(resolve => QRCode.toDataURL(
	    `otpauth://totp/${title}?secret=${key}&issuer=TekMonks&algorithm=sha1&digits=6&period=30`, (_, data_url) => resolve(data_url)));
}

const showMessage = message => dialog().showMessage(message, "dialog");

export const main = {toggleMenu, changePassword, showOTPQRCode, showLoginMessages, changeProfile, logoutClicked, 
    interceptPageData, gohome, addGoHomeListener, showMessage, showNotifications}