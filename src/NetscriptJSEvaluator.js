import {makeRuntimeRejectMsg} from "./NetscriptEvaluator";

// Makes a blob that contains the code of a given script.
export function makeScriptBlob(code) {
    return new Blob([code], {type: "text/javascript"});
}

// Begin executing a user JS script, and return a promise that resolves
// or rejects when the script finishes.
// - script is a script to execute (see Script.js). We depend only on .filename and .code.
// scripts is an array of other scripts on the server.
// env is the global environment that should be visible to all the scripts
// (i.e. hack, grow, etc.).
// When the promise returned by this resolves, we'll have finished
// running the main function of the script.
export async function executeJSScript(scripts = [], workerScript) {
    let loadedModule;
    let urlStack = null;
    let script = workerScript.getScript();
    if (script.module === "") {
        // The URL at the top is the one we want to import. It will
        // recursively import all the other modules in the urlStack.
        //
        // Webpack likes to turn the import into a require, which sort of
        // but not really behaves like import. Particularly, it cannot
        // load fully dynamic content. So we hide the import from webpack
        // by placing it inside an eval call.
        urlStack = _getScriptUrls(script, scripts, []);
        script.module = await eval('import(urlStack[urlStack.length - 1])');
    }
    loadedModule = script.module;

    let ns      = workerScript.env.vars;
    //ns.threads  = workerScript.threads;
    //ns.args     = workerScript.args;

    try {
        // TODO: putting await in a non-async function yields unhelpful
        // "SyntaxError: unexpected reserved word" with no line number information.
        if (!loadedModule.main) {
            throw makeRuntimeRejectMsg(workerScript, `${script.filename} cannot be run because it does not have a main function.`);
        }
        return loadedModule.main(ns);
    } finally {
        // Revoke the generated URLs
        if (urlStack != null) {
            for (const url in urlStack) URL.revokeObjectURL(url);
        }
    };
}

// Gets a stack of blob urls, the top/right-most element being
// the blob url for the named script on the named server.
//
// - script -- the script for whom we are getting a URL.
// - scripts -- all the scripts available on this server
// - seen -- The modules above this one -- to prevent mutual dependency.
//
// TODO We don't make any effort to cache a given module when it is imported at
// different parts of the tree. That hasn't presented any problem with during
// testing, but it might be an idea for the future. Would require a topo-sort
// then url-izing from leaf-most to root-most.
export function _getScriptUrls(script, scripts, seen) {
    // Inspired by: https://stackoverflow.com/a/43834063/91401
    const urlStack = [];
    seen.push(script);
    try {
        // Replace every import statement with an import to a blob url containing
        // the corresponding script. E.g.
        //
        // import {foo} from "bar.js";
        //
        // becomes
        //
        // import {foo} from "blob://<uuid>"
        //
        // Where the blob URL contains the script content.
        const transformedCode = script.code.replace(/((?:from|import)\s+(?:'|"))([^'"]+)('|";)/g,
            (unmodified, prefix, filename, suffix) => {
                const isAllowedImport = scripts.some(s => s.filename == filename);
                if (!isAllowedImport) return unmodified;

                // Find the corresponding script.
                const [importedScript] = scripts.filter(s => s.filename == filename);

                // Try to get a URL for the requested script and its dependencies.
                const urls = _getScriptUrls(importedScript, scripts, seen);

                // The top url in the stack is the replacement import file for this script.
                urlStack.push(...urls);
                return [prefix, urls[urls.length - 1], suffix].join('');
            }
        );


        // If we successfully transformed the code, create a blob url for it and
        // push that URL onto the top of the stack.
        urlStack.push(URL.createObjectURL(makeScriptBlob(transformedCode)));
        return urlStack;
    } catch (err) {
        // If there is an error, we need to clean up the URLs.
        for (const url in urlStack) URL.revokeObjectURL(url);
        throw err;
    } finally {
        seen.pop();
    }
}
