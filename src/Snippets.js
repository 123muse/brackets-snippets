define(function (require, exports, module) {
    "use strict";

    // Brackets modules
    var _               = brackets.getModule("thirdparty/lodash"),
        ExtensionUtils  = brackets.getModule("utils/ExtensionUtils"),
        FileSystem      = brackets.getModule("filesystem/FileSystem");

    // Local modules
    var ErrorHandler  = require("src/ErrorHandler"),
        Preferences   = require("src/Preferences"),
        Promise       = require("bluebird"),
        SnippetDialog = require("src/SnippetDialog"),
        Strings       = require("strings"),
        Utils         = require("src/Utils");

    // Local variables
    var SnippetCollection = [],
        lastSnippetId = 0;

    // src https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
    function escapeRegExp(string) {
        return string.replace(/([.*+?^${}()|\[\]\/\\])/g, "\\$1");
    }

    function _sortSnippets() {
        SnippetCollection.sort(function (a, b) {
            return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
        });
    }

    function getDefaultSnippetDirectory() {
        return brackets.app.getApplicationSupportDirectory() + "/snippets/";
    }

    // TODO: re-analyze now that user and gist snippets are no more
    function loadSnippet(snippet) {
        // snippet.source === "directory"
        // snippet.source === "user";
        // snippet.source === "gist";

        var ignoreLoad = false;

        var existingSnippet = _.find(SnippetCollection, function (s) {
            return s.name === snippet.name;
        });

        if (existingSnippet) {
            if (!existingSnippet.source || existingSnippet.source === "directory") {
                // directory snippets can be always overridden
                ignoreLoad = false;
            } else if (existingSnippet.source === "user") {
                // user snippets can only be overriden by user snippets
                if (snippet.source !== "user") {
                    ignoreLoad = true;
                }
            } else if (existingSnippet.source === "gist") {
                // gist snippets can be overriden by user snippets and gist snippets
                if (snippet.source !== "user" && snippet.source !== "gist") {
                    ignoreLoad = true;
                }
            } else {
                ErrorHandler.show("loadSnippet(): Unknown snippet source: " + existingSnippet.source);
            }
        }

        if (ignoreLoad) {
            console.log("[brackets-snippets] ignoring loading of '" + snippet.name +
                        "' snippet, because snippet with the same name of source '" + existingSnippet.source +
                        "' is present.");
            return;
        }

        if (existingSnippet) {
            var io = SnippetCollection.indexOf(existingSnippet);
            if (io !== -1) {
                SnippetCollection.splice(io, 1);
            }
        }

        // every snippets needs to have an unique generated ID
        snippet._id = ++lastSnippetId;
        SnippetCollection.push(snippet);
        _sortSnippets();
    }

    // TODO: will we allow updating the names?
    // TODO: make sure users don't update default_snippets
    function updateSnippet(newSnippet) {
        var oldSnippet = _.find(SnippetCollection, function (s) {
            return s._id === newSnippet._id;
        });
        Object.keys(newSnippet).forEach(function (key) {
            oldSnippet[key] = newSnippet[key];
        });
        _sortSnippets();
    }

    function deleteSnippet(snippet) {
        var defer = Promise.defer();

        FileSystem.resolve(snippet.snippetFilePath, function (err, file) {

            if (err) {
                ErrorHandler.show(err);
                defer.reject();
                return;
            }

            file.unlink(function (err) {

                if (err) {
                    ErrorHandler.show(err);
                    defer.reject();
                    return;
                }

                var idx = SnippetCollection.length;
                while (idx--) {
                    if (SnippetCollection[idx]._id === snippet._id) {
                        SnippetCollection.splice(idx, 1);
                    }
                }
                defer.resolve();

            });

        });

        return defer.promise;
    }

    // TODO: reimplement to work with default snippet directory
    function clearAll() {
        while (SnippetCollection.length > 0) {
            SnippetCollection.splice(0, 1);
        }
    }

    function _registerSnippetDirectory(directory) {
        var snippetDirectories = Preferences.get("snippetDirectories");

        var entry = _.find(snippetDirectories, function (e) {
            return e.fullPath === directory.fullPath;
        });

        // if doesn't exist, add it to the collection, automatically load new directories
        if (!entry) {
            entry = {
                fullPath: directory.fullPath,
                autoLoad: true
            };
            snippetDirectories.push(entry);
            Preferences.set("snippetDirectories", snippetDirectories);
        }
    }

    function loadSnippetsFromDirectories() {
        var snippetDirectories = Preferences.get("snippetDirectories");

        // always add defaultSnippetDirectory
        var defaultSnippetDirectory = Preferences.get("defaultSnippetDirectory");
        snippetDirectories.push({
            fullPath: defaultSnippetDirectory,
            autoLoad: true
        });

        snippetDirectories.forEach(function (snippetDirectory) {

            // skip directories we don't want to load on startup
            if (snippetDirectory.autoLoad !== true) {
                console.log("[brackets-snippets] skipping directory: " + snippetDirectory.fullPath);
                return;
            }

            if (!FileSystem.isAbsolutePath(snippetDirectory.fullPath)) {
                snippetDirectory.autoLoad = false;
                ErrorHandler.show("Directory is not an absolute path: " + snippetDirectory.fullPath);
                Preferences.set("snippetDirectories", snippetDirectories);
                return;
            }

            FileSystem.resolve(snippetDirectory.fullPath, function (err, directory) {
                if (err) {
                    ErrorHandler.show(err);
                    return;
                }

                if (directory.isDirectory !== true) {
                    snippetDirectory.autoLoad = false;
                    Preferences.set("snippetDirectories", snippetDirectories);
                    ErrorHandler.show("loadSnippetsFromDirectories: " + snippetDirectory.fullPath + " is not a directory!");
                    return;
                }

                directory.getContents(function (err, directoryContents) {
                    if (err) {
                        ErrorHandler.show(err);
                        return;
                    }
                    directoryContents.forEach(function (snippetFile) {
                        if (!snippetFile.isFile) {
                            return;
                        }
                        snippetFile.read(function (err, content) {
                            if (err) {
                                ErrorHandler.show(err);
                                return;
                            }
                            loadSnippet({
                                name: snippetFile.name,
                                template: content,
                                source: "directory",
                                snippetFilePath: snippetFile.fullPath
                            });
                        });
                    });
                });
            });
        });
    }

    function checkDefaultSnippetsDirectories() {
        var defer = Promise.defer();

        var modulePath = ExtensionUtils.getModulePath(module);
        FileSystem.resolve(modulePath + "../default_snippets/", function (err, entry) {

            if (err) {
                ErrorHandler.show(err);
                defer.reject();
                return;
            }

            entry.getContents(function (err, contents) {

                if (err) {
                    ErrorHandler.show(err);
                    defer.reject();
                    return;
                }

                // register every directory which contains a set of snippets
                contents.forEach(function (directory) {
                    _registerSnippetDirectory(directory);
                });

                // finish
                defer.resolve();

            });

        });

        return defer.promise;
    }

    function ensureDefaultSnippetDirectory() {
        var defer = Promise.defer();

        var defaultSnippetDirectory = Preferences.get("defaultSnippetDirectory");
        if (!defaultSnippetDirectory) {
            defaultSnippetDirectory = getDefaultSnippetDirectory();
        }

        // fix windows paths
        defaultSnippetDirectory = defaultSnippetDirectory.replace(/\\/g, "/");

        // fix missing trailing slash
        if (defaultSnippetDirectory.slice(-1) !== "/") {
            defaultSnippetDirectory += "/";
        }

        FileSystem.resolve(defaultSnippetDirectory, function (err, directory) {
            // handle NotFound error
            if (err === "NotFound") {
                brackets.fs.makedir(defaultSnippetDirectory, parseInt("777", 0), function (err) {
                    if (err) {
                        ErrorHandler.show(err);
                        defer.reject("makedir failed: " + err);
                        return;
                    }
                    defer.resolve(true);
                });
                return;
            }
            // all other errors
            if (err) {
                ErrorHandler.show(err);
                defer.reject("unknown error: " + err);
                return;
            }
            // exists but it's not a directory
            if (!directory.isDirectory) {
                ErrorHandler.show("Target is not a directory: " + defaultSnippetDirectory);
                defer.reject("default is not a directory");
                return;
            }
            defer.resolve(true);
        });

        return defer.promise
            .catch(function (reason) {
                Preferences.set("defaultSnippetDirectory", getDefaultSnippetDirectory());
                throw reason;
            })
            .then(function () {
                Preferences.set("defaultSnippetDirectory", defaultSnippetDirectory);
            });
    }

    // TODO: we need a migration for Preferences.get("SnippetsCollection") into default snippets directory
    function init() {
        ensureDefaultSnippetDirectory()
            .then(function () {
                return checkDefaultSnippetsDirectories();
            })
            .then(function () {
                return loadSnippetsFromDirectories();
            });
    }

    function getAll() {
        return SnippetCollection;
    }

    function search(query) {
        if (!query) {
            return getAll();
        }
        var regExp = new RegExp(escapeRegExp(query), "i");
        return _.filter(SnippetCollection, function (snippet) {
            return regExp.test(snippet.name);
        });
    }

    function addNewSnippetDialog(snippet) {
        return SnippetDialog.show(snippet, function (newSnippet) {
            // dialog should only be closed, if this promise is resolved
            var defer = Promise.defer();

            var newFileName = Preferences.get("defaultSnippetDirectory") + newSnippet.name;
            FileSystem.resolve(newFileName, function (err) {

                // NotFound is desired here, because we should be writing new file to disk
                if (err === "NotFound") {
                    FileSystem.getFileForPath(newFileName).write(newSnippet.template, function (err) {

                        // error writing the file to disk
                        if (err) {
                            ErrorHandler.show(err);
                            defer.reject();
                            return;
                        }

                        // successfully saved new snippet to disk
                        newSnippet.source = "directory";
                        newSnippet.snippetFilePath = newFileName;
                        loadSnippet(newSnippet);
                        defer.resolve();

                    });
                    return;
                }

                // error resolving the file, it may or may not exist
                if (err) {
                    ErrorHandler.show(err);
                    defer.reject();
                    return;
                }

                // no error resolving the file, it already exists
                ErrorHandler.show("File already exists: " + newFileName);
                defer.reject();

            });

            return defer.promise;
        });
    }

    function _renameSnippetFile(oldName, newName, oldFullPath) {
        var defer = Promise.defer();

        // decide on the new name
        var split = oldFullPath.split("/");
        split.pop(); // removes old name
        split.push(newName); // adds new name
        var newFullPath = split.join("/");

        FileSystem.resolve(oldFullPath, function (err, file) {

            // error resolving the file
            if (err) {
                ErrorHandler.show(err);
                defer.reject();
                return;
            }

            file.rename(newFullPath, function (err) {

                // target file already exists
                if (err === "AlreadyExists") {
                    ErrorHandler.show("File already exists: " + newFullPath);
                    defer.reject();
                    return;
                }

                // error renaming the file
                if (err) {
                    ErrorHandler.show(err);
                    defer.reject();
                    return;
                }

                defer.resolve(newFullPath);

            });

        });

        return defer.promise;
    }

    function _overwriteSnippetFile(fullPath, content) {
        var defer = Promise.defer();

        FileSystem.resolve(fullPath, function (err, file) {

            // error resolving the snippet file
            if (err) {
                ErrorHandler.show(err);
                defer.reject();
                return;
            }

            // we need a blind write here because file could have been just renamed
            // and fs was not able to pick up on the changes yet
            file.write(content, function (err) {

                // error writing to the snippet file
                if (err) {
                    ErrorHandler.show(err);
                    defer.reject();
                    return;
                }

                // success
                defer.resolve();

            });

        });

        return defer.promise;
    }

    function editSnippetDialog(snippet) {
        var oldName             = snippet.name,
            isDirectorySnippet  = snippet.source === "directory";

        if (!isDirectorySnippet) {
            ErrorHandler.show("Can't edit non-directory snippet");
            return;
        }

        return SnippetDialog.show(snippet, function (newSnippet) {
            var defer   = Promise.defer(),
                newName = newSnippet.name;

            var writeContent = function () {
                _overwriteSnippetFile(newSnippet.snippetFilePath, newSnippet.template)
                    .then(function () {
                        defer.resolve();
                    }).catch(function () {
                        defer.reject();
                    });
            };

            if (oldName !== newName) {

                // we need to rename the file
                _renameSnippetFile(oldName, newName, snippet.snippetFilePath)
                    .then(function (newFullPath) {

                        // save the new path to the snippet object
                        newSnippet.snippetFilePath = newFullPath;

                        // write template changes to disk
                        writeContent();

                    }).catch(function () {
                        defer.reject();
                    });

            } else {

                // write template changes to disk
                writeContent();

            }

            return defer.promise.then(function () {

                // update snippet if all went fine
                return updateSnippet(newSnippet);

            });
        });
    }

    function deleteSnippetDialog(snippet) {
        return Utils.askQuestion(Strings.QUESTION, Strings.SNIPPET_DELETE_CONFIRM, "boolean")
            .then(function (response) {
                if (response === true) {
                    return deleteSnippet(snippet);
                }
            });
    }

    function deleteAllSnippetsDialog() {
        return Utils.askQuestion(Strings.QUESTION, Strings.SNIPPET_DELETE_ALL_CONFIRM, "boolean")
            .then(function (response) {
                if (response === true) {
                    return clearAll();
                }
            });
    }

    exports.init                        = init;
    exports.clearAll                    = clearAll;
    exports.getAll                      = getAll;
    exports.loadSnippet                 = loadSnippet;
    exports.search                      = search;
    exports.addNewSnippetDialog         = addNewSnippetDialog;
    exports.editSnippetDialog           = editSnippetDialog;
    exports.deleteSnippetDialog         = deleteSnippetDialog;
    exports.deleteAllSnippetsDialog     = deleteAllSnippetsDialog;
    exports.getDefaultSnippetDirectory  = getDefaultSnippetDirectory;

});
