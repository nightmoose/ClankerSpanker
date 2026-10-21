"use strict";

const { dirname } = require("node:path").posix;

/**
 * RFC-066. The shell is a local file page. A new window is always denied.
 * Navigation stays on that page. An off-origin http(s) URL is handed to the
 * system browser; other schemes (javascript:, file: outside the page
 * directory) are dropped.
 *
 * `file:` origins are the string "null" for every path, so same-origin is
 * the loaded file's directory, not `URL.origin`.
 */

function classifyNavigation(appUrl, targetUrl) {
  let target;
  try {
    target = new URL(targetUrl);
  } catch {
    return { inApp: false, openExternal: false };
  }

  const external = target.protocol === "http:" || target.protocol === "https:";
  if (!appUrl) {
    if (target.protocol === "file:") return { inApp: true, openExternal: false };
    return { inApp: false, openExternal: external };
  }

  let app;
  try {
    app = new URL(appUrl);
  } catch {
    return { inApp: false, openExternal: external };
  }

  if (app.protocol === "file:" && target.protocol === "file:") {
    return { inApp: fileInApp(app.pathname, target.pathname), openExternal: false };
  }

  if (app.origin !== "null" && target.origin === app.origin) {
    return { inApp: true, openExternal: false };
  }

  return { inApp: false, openExternal: external };
}

function fileInApp(appPath, targetPath) {
  if (targetPath === appPath) return true;
  const root = dirname(appPath).replace(/\/?$/, "/");
  return targetPath.startsWith(root);
}

/**
 * @param {{ webContents: { getURL?: () => string, setWindowOpenHandler: (cb: (details: { url: string }) => { action: string }) => void, on: (event: string, cb: (event: { preventDefault: () => void }, url: string) => void) => void } }} win
 * @param {{ openExternal: (url: string) => unknown }} shell
 */
function installNavigationGuards(win, shell) {
  const wc = win.webContents;
  const appUrl = () => {
    try {
      return typeof wc.getURL === "function" ? wc.getURL() || "" : "";
    } catch {
      return "";
    }
  };

  wc.setWindowOpenHandler(({ url }) => {
    const decision = classifyNavigation(appUrl(), url);
    if (decision.openExternal) shell.openExternal(url);
    return { action: "deny" };
  });

  wc.on("will-navigate", (event, url) => {
    const decision = classifyNavigation(appUrl(), url);
    if (decision.inApp) return;
    event.preventDefault();
    if (decision.openExternal) shell.openExternal(url);
  });
}

module.exports = { classifyNavigation, installNavigationGuards };
