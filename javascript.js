/* jshint -W097 */// jshint strict:false
/*jslint node: true */
"use strict";

(function () {

    var mods = {
        'vm':               require('vm'),
        'fs':               require('fs'),
        'dgram':            require('dgram'),
        'crypto':           require('crypto'),
        'dns':              require('dns'),
        'events':           require('events'),
        'http':             require('http'),
        'https':            require('https'),
        'net':              require('net'),
        'os':               require('os'),
        'path':             require('path'),
        'util':             require('util'),
        'child_process':    require('child_process'),

        'coffee-compiler':  require('coffee-compiler'),

        'node-schedule':    require('node-schedule'),
        'suncalc':          require('suncalc'),
        'request':          require('request'),
        'wake_on_lan':      require('wake_on_lan')
    };
    var utils =   require(__dirname + '/lib/utils'); // Get common adapter utils

    var adapter = utils.adapter({

        name: 'javascript',

        objectChange: function (id, obj) {
            if (!obj) {
                if (!objects[id]) return;

                // Script deleted => remove it
                if (objects[id].common.engine == 'system.adapter.' + adapter.namespace) stop(id);

                delete objects[id];
            } else if (!objects[id]) {
                objects[id] = obj;

                if (obj.type != 'script' || obj.common.engine != 'system.adapter.' + adapter.namespace || !obj.common.enabled) return;
                // added new script to this engine

            } else {
                // Object just changed
                if (obj.type != 'script') {
                    objects[id] = obj;
                    return;
                }
                if (objects[id].common.name.indexOf('_global') != -1) {
                    // restart adapter
                    adapter.getForeignObject('system.adapter.' + adapter.namespace, function (err, obj) {
                        if (obj) {
                            adapter.setForeignObject('system.adapter.' + adapter.namespace, obj);
                        }
                    });
                    return;
                }

                if ((objects[id].common.enabled && !obj.common.enabled) ||
                    (objects[id].common.engine == 'system.adapter.' + adapter.namespace && obj.common.engine != 'system.adapter.' + adapter.namespace)) {
                    // Script disabled
                    if (objects[id].common.enabled && objects[id].common.engine == 'system.adapter.' + adapter.namespace) {
                        // Remove it from executing
                        objects[id] = obj;
                        stop(id);
                    } else {
                        objects[id] = obj;
                    }
                } else
                if ((!objects[id].common.enabled && obj.common.enabled) ||
                    (objects[id].common.engine != 'system.adapter.' + adapter.namespace && obj.common.engine == 'system.adapter.' + adapter.namespace)) {
                    // Script enabled
                    objects[id] = obj;

                    if (objects[id].common.enabled && objects[id].common.engine == 'system.adapter.' + adapter.namespace) {
                        // Start script
                        load(id);
                    }
                } else { //if (obj.common.source != objects[id].common.source) {
                    objects[id] = obj;

                    // Source changed => restart it
                    stop(id, function (res, _id) {
                        load(_id);
                    });
                } /*else {
                    // Something changed or not for us
                    objects[id] = obj;
                }*/
            }
        },

        stateChange: function (id, state) {

            if (id.match(/^messagebox./) || id.match(/^log./)) return;

            var oldState = states[id] || {};
            if (state) {
                states[id] = state;
            } else {
                delete states[id];
                state = {};
            }

            var eventObj = {
                id: id,
                //name: name,
                //common: common,
                //native: nativeObj,
                //channelId: channelId,
                //channelName: channelName,
                //deviceId: deviceId,
                //deviceName: deviceName,
                //enumIds: enumIds,       // Array of Strings
                //enumNames: enumNames,     // Array of Strings
                newState: {
                    val: state.val,
                    ts: state.ts,
                    ack: state.ack,
                    lc: state.lc,
                    from: state.from
                },
                oldState: {
                    val: oldState.val,
                    ts: oldState.ts,
                    ack: oldState.ack,
                    lc: oldState.lc,
                    from: oldState.from
                }
            };

            if (isEnums) {
                getObjectEnums(id, function (enumIds, enumNames) {
                    eventObj.enumIds   = enumIds;
                    eventObj.enumNames = enumNames;
                    checkPatterns(eventObj);
                });
            } else {
                checkPatterns(eventObj);
            }
        },

        unload: function (callback) {
            callback();
        },

        ready: function () {
            installLibraries(function () {
                getData(function () {
                    adapter.subscribeForeignObjects('*');
                    adapter.subscribeForeignStates('*');

                    adapter.objects.getObjectView('script', 'javascript', {}, function (err, doc) {
                        globalScript = '';
                        var count = 0;

                        // assemble global script
                        for (var g = 0; g < doc.rows.length; g++) {
                            if (doc.rows[g].value.common.name.indexOf('_global') != -1) {
                                var obj = doc.rows[g].value;

                                if (obj && obj.common.enabled) {
                                    if (obj.common.engineType.match(/^[cC]offee/)) {
                                        count++;
                                        mods['coffee-compiler'].fromSource(obj.common.source, {
                                            sourceMap: false,
                                            bare: true
                                        }, function (err, js) {
                                            if (err) {
                                                adapter.log.error(obj.common.name + ' coffee compile ' + err);
                                                return;
                                            }
                                            globalScript += js + '\n';
                                            if (!(--count)) {
                                                // load all scripts
                                                for (var i = 0; i < doc.rows.length; i++) {
                                                    if (doc.rows[i].value.common.name.indexOf('_global') == -1) {
                                                        load(doc.rows[i].value._id);
                                                    }
                                                }
                                            }
                                        });
                                    } else {
                                        globalScript += doc.rows[g].value.common.source + '\n';
                                    }
                                }
                            }
                        }

                        if (!count) {
                            // load all scripts
                            for (var i = 0; i < doc.rows.length; i++) {
                                if (doc.rows[i].value.common.name.indexOf('_global') == -1) {
                                    load(doc.rows[i].value._id);
                                }
                            }
                        }
                    });
                });
            });
        }
    });

    var objects =          {};
    var states =           {};
    var scripts =          {};
    var subscriptions =    [];
    var isEnums =          false; // If some subscription wants enum
    var enums =            [];
    var cacheObjectEnums = {};
    var channels =         null;
    var devices =          null;
    var fs =               null;
    var attempts =         {};
    var globalScript =     '';

    function checkPatterns(eventObj) {
        // if this state matchs any subscriptions
        var matched = false;
        var subs = [];
        for (var i = 0, l = subscriptions.length; i < l; i++) {
            var pattern = subscriptions[i].pattern;
            // possible matches
            //    pattern.name
            //    pattern.channelId
            //    pattern.channelName
            //    pattern.deviceId
            //    pattern.deviceName
            //    pattern.enumId
            //    pattern.enumName
            if (!matched) {
                if (eventObj.name === undefined && pattern.name) {
                    eventObj.common = objects[eventObj.id] ? objects[eventObj.id].common : {};
                    eventObj.native = objects[eventObj.id] ? objects[eventObj.id].native : {};
                    eventObj.name   = eventObj.common ? eventObj.common.name : null;
                }

                if (eventObj.channelId === undefined && (pattern.deviceId || pattern.deviceName || pattern.channelId || pattern.channelName)) {
                    var pos = eventObj.id.lastIndexOf('.');
                    if (pos != -1) eventObj.channelId = eventObj.id.substring(0, pos);
                    if (!objects[eventObj.channelId]) eventObj.channelId = null;
                }

                if (eventObj.channelName === undefined && pattern.channelName) {
                    if (eventObj.channelId && objects[eventObj.channelId]) {
                        eventObj.channelName = objects[eventObj.channelId].common ? objects[eventObj.channelId].common.name : null;
                    } else {
                        eventObj.channelName = null;
                    }
                }

                if (eventObj.deviceId === undefined && (pattern.deviceId || pattern.deviceName)) {
                    if (!eventObj.channelId) {
                        eventObj.deviceId   = null;
                        eventObj.deviceName = null;
                    } else {
                        var pos = eventObj.channelId.lastIndexOf('.');
                        if (pos != -1) {
                            eventObj.deviceId = eventObj.channelId.substring(0, pos);
                            if (!objects[eventObj.deviceId]) {
                                eventObj.deviceId   = null;
                                eventObj.deviceName = null;
                            }
                        }
                    }
                }
                if (eventObj.deviceName === undefined && pattern.deviceName) {
                    eventObj.deviceName = objects[eventObj.deviceId] && objects[eventObj.deviceId].common ? objects[eventObj.deviceId].common.name : null;
                }
            }

            if (patternMatching(eventObj, subscriptions[i].pattern)) {
                if (!matched) {
                    matched = true;
                    if (eventObj.name === undefined) {
                        eventObj.common = objects[eventObj.id] ? objects[eventObj.id].common : {};
                        eventObj.native = objects[eventObj.id] ? objects[eventObj.id].native : {};
                        eventObj.name   = eventObj.common ? eventObj.common.name : null;
                    }

                    if (eventObj.channelId === undefined) {
                        var pos = eventObj.id.lastIndexOf('.');
                        if (pos != -1) eventObj.channelId = eventObj.id.substring(0, pos);
                        if (!objects[eventObj.channelId]) eventObj.channelId = null;
                    }

                    if (eventObj.channelName === undefined) {
                        if (eventObj.channelId && objects[eventObj.channelId]) {
                            eventObj.channelName = objects[eventObj.channelId].common ? objects[eventObj.channelId].common.name : null;
                        } else {
                            eventObj.channelName = null;
                        }
                    }

                    if (eventObj.deviceId === undefined) {
                        if (!eventObj.channelId) {
                            eventObj.deviceId   = null;
                            eventObj.deviceName = null;
                        } else {
                            var pos = eventObj.channelId.lastIndexOf('.');
                            if (pos != -1) {
                                eventObj.deviceId = eventObj.channelId.substring(0, pos);
                                if (!objects[eventObj.deviceId]) {
                                    eventObj.deviceId   = null;
                                    eventObj.deviceName = null;
                                }
                            }
                        }
                    }
                    if (eventObj.deviceName === undefined) {
                        eventObj.deviceName = objects[eventObj.deviceId] && objects[eventObj.deviceId].common ? objects[eventObj.deviceId].common.name : null;
                    }
                }
                subs.push(i);
            }
        }

        if (matched) {
            if (eventObj.enumIds === undefined) {
                getObjectEnums(eventObj.id, function (enumIds, enumNames) {
                    eventObj.enumIds   = enumIds;
                    eventObj.enumNames = enumNames;
                    for (var i = 0, l = subs.length; i < l; i++) {
                        subscriptions[subs[i]].callback(eventObj);
                    }
                });
            } else {
                for (var i = 0, l = subs.length; i < l; i++) {
                    subscriptions[subs[i]].callback(eventObj);
                }
            }
        }
   }

    function installNpm(npmLib, callback) {
        var path = __dirname;
        if (typeof npmLib == 'function') {
            callback = npmLib;
            npmLib = undefined;
        }

        var cmd = 'npm install ' + npmLib + ' --production --prefix "' + path + '"';
        adapter.log.info(cmd + ' (System call)');
        // Install node modules as system call

        // System call used for update of js-controller itself,
        // because during installation npm packet will be deleted too, but some files must be loaded even during the install process.
        var exec = require('child_process').exec;
        var child = exec(cmd);

        child.stdout.on('data', function(buf) {
            adapter.log.info(buf.toString('utf8'));
        });
        child.stderr.on('data', function(buf) {
            adapter.log.error(buf.toString('utf8'));
        });
        
        child.on('exit', function (code, signal) {
            if (code) {
                adapter.log.error('Cannot install ' + npmLib + ': ' + code);
            }
            // command succeeded
            if (callback) callback(npmLib);
        });
    }

    function installLibraries(callback) {
        var allInstalled = true;
        if (adapter.common && adapter.common.npmLibs) {
            for (var lib = 0; lib < adapter.common.npmLibs.length; lib++) {
                if (adapter.common.npmLibs[lib] && adapter.common.npmLibs[lib].trim()) {
                    adapter.common.npmLibs[lib] = adapter.common.npmLibs[lib].trim();
                    fs = fs || require('fs');

                    if (!fs.existsSync(__dirname + '/node_modules/' + adapter.common.npmLibs[lib] + '/package.json')) {

                        if (!attempts[adapter.common.npmLibs[lib]]) {
                            attempts[adapter.common.npmLibs[lib]] = 1;
                        } else {
                            attempts[adapter.common.npmLibs[lib]]++;
                        }
                        if (attempts[adapter.common.npmLibs[lib]] > 3) {
                            adapter.log.error('Cannot install npm packet: ' + adapter.common.npmLibs[lib]);
                            continue;
                        }

                        installNpm(adapter.common.npmLibs[lib], function () {
                            installLibraries(callback);
                        });
                        allInstalled = false;
                    }
                }
            }
        }
        if (allInstalled) callback();
    }

    function compile(source, name) {
        source += "\n;\nlog('registered ' + __engine.__subscriptions + ' subscription' + (__engine.__subscriptions === 1 ? '' : 's' ) + ' and ' + __engine.__schedules + ' schedule' + (__engine.__schedules === 1 ? '' : 's' ));\n";
        try {
            return mods.vm.createScript(source, name);
        } catch (e) {
            adapter.log.error(name + ' compile failed: ' + e);
            return false;
        }
    }

    function execute(script, name) {
        script.intervals = [];
        script.timeouts  = [];
        script.schedules = [];
        script.name      = name;
        script._id       = Math.floor(Math.random() * 0xFFFFFFFF);

        var sandbox = {
            mods:      mods,
            _id:       script._id,
            require:   function (md) {
                if (mods[md]) return mods[md];
                try {
                    mods[md] = require(__dirname + '/node_modules/' + md);
                    return mods[md];
                } catch (e) {
                    var lines = e.stack.split('\n');
                    var stack = [];
                    for (var i = 6; i < lines.length; i++) {
                        if (lines[i].match(/runInNewContext/)) break;
                        stack.push(lines[i]);
                    }
                    adapter.log.error(name + ': ' + e.message + '\n' + stack);

                }
            },
            Buffer:    Buffer,
            __engine:  {
                        __subscriptions: 0,
                        __schedules: 0
            },
            $:         function (selector) {
                // following is supported
                // 'type[commonAttr=something]', 'id[commonAttr=something]', id(enumName="something")', id{nativeName="something"}
                // Type can be state, channel or device
                // Attr can be any of the common attributes and can have wildcards *
                // E.g. "state[id='hm-rpc.0.*]" or "hm-rpc.0.*" returns all states of adapter instance hm-rpc.0
                // channel(room="Living room") => all states in room "Living room"
                // channel{TYPE=BLIND}[state.id=*.LEVEL]
                // Switch all states with .STATE of channels with role "switch" in "Wohnzimmer" to false
                // $('channel[role=switch][state.id=*.STATE](rooms=Wohnzimmer)').setState(false);
                //
                // Following functions are possible, setValue, getValue (only from first), on, each

                // Todo CACHE!!!

                var result    = {};

                var name      = '';
                var commons   = [];
                var _enums    = [];
                var natives   = [];
                var isName    = true;
                var isCommons = false;
                var isEnums   = false;
                var isNatives = false;
                var common    = '';
                var native    = '';
                var _enum     = '';
                var parts;
                var len;

                // parse string
                for (var i = 0; i < selector.length; i++) {
                    if (selector[i] == '{') {
                        isName = false;
                        if (isCommons || isEnums || isNatives) {
                            // Error
                            return [];
                        }
                        isNatives = true;
                    } else
                    if (selector[i] == '}') {
                        isNatives = false;
                        natives.push(native);
                        native = '';
                    } else
                    if (selector[i] == '[') {
                        isName = false;
                        if (isCommons || isEnums || isNatives) {
                            // Error
                            return [];
                        }
                        isCommons = true;
                    } else
                    if (selector[i] == ']') {
                        isCommons = false;
                        commons.push(common);
                        common = '';
                    }else
                    if (selector[i] == '(') {
                        isName = false;
                        if (isCommons || isEnums || isNatives) {
                            // Error
                            return [];
                        }
                        isEnums = true;
                    } else
                    if (selector[i] == ')') {
                        isEnums = false;
                        _enums.push(_enum);
                        _enum = '';
                    } else
                    if (isName)    {
                        name    += selector[i];
                    } else
                    if (isCommons) {
                        common  += selector[i];
                    } else
                    if (isEnums)  {
                        _enum += selector[i];
                    } else
                    if (isNatives) {
                        native  += selector[i];
                    } //else {
                        // some error
                    //}
                }

                // If some error in the selector
                if (isEnums || isCommons || isNatives) {
                    result.length = 0;
                    result.each = function () {
                        return this;
                    };
                    result.getState = function () {
                        return null;
                    };
                    result.setState = function () {
                        return this;
                    };
                    result.on = function () {
                    };
                }

                if (isEnums) {
                    adapter.log.warn('Invalid selector: enum close bracket cannot be found in "' + selector + '"');
                    result.error = 'Invalid selector: enum close bracket cannot be found';
                    return result;
                } else if (isCommons) {
                    adapter.log.warn('Invalid selector: common close bracket cannot be found in "' + selector + '"');
                    result.error = 'Invalid selector: common close bracket cannot be found';
                    return result;
                } else if (isNatives) {
                    adapter.log.warn('Invalid selector: native close bracket cannot be found in "' + selector + '"');
                    result.error = 'Invalid selector: native close bracket cannot be found';
                    return result;
                }

                var filterStates = [];

                for (i = 0; i < commons.length; i++) {
                    parts = commons[i].split('=', 2);
                    if (parts[1] && parts[1][0] == '"') {
                        parts[1] = parts[1].substring(1);
                        len = parts[1].length;
                        if (parts[1] && parts[1][len - 1] == '"') parts[1] = parts[1].substring(0, len - 1);
                    }
                    if (parts[1] && parts[1][0] == "'") {
                        parts[1] = parts[1].substring(1);
                        len = parts[1].length;
                        if (parts[1] && parts[1][len - 1] == "'") parts[1] = parts[1].substring(0, len - 1);
                    }

                    if (parts[1]) parts[1] = parts[1].trim();
                    parts[0] = parts[0].trim();

                    if (parts[0] == 'state.id') {
                        filterStates.push({attr: parts[0], value: parts[1].trim()});
                        commons[i] = null;
                    } else {
                        commons[i] = {attr: parts[0], value: parts[1].trim()};
                    }
                }

                for (i = 0; i < natives.length; i++) {
                    parts = natives[i].split('=', 2);
                    if (parts[1] && parts[1][0] == '"') {
                        parts[1] = parts[1].substring(1);
                        len = parts[1].length;
                        if (parts[1] && parts[1][len - 1] == '"') parts[1] = parts[1].substring(0, len - 1);
                    }
                    if (parts[1] && parts[1][0] == "'") {
                        parts[1] = parts[1].substring(1);
                        len = parts[1].length;
                        if (parts[1] && parts[1][len - 1] == "'") parts[1] = parts[1].substring(0, len - 1);
                    }

                    if (parts[1]) parts[1] = parts[1].trim();
                    parts[0] = parts[0].trim();
                    if (parts[0] == 'state.id') {
                        filterStates.push({attr: parts[0], value: parts[1].trim()});
                        natives[i] = null;
                    } else {
                        natives[i] = {attr: parts[0].trim(), value: parts[1].trim()};
                    }
                }

                for (i = 0; i < _enums.length; i++) {
                    parts = _enums[i].split('=', 2);
                    if (parts[1] && parts[1][0] == '"') {
                        parts[1] = parts[1].substring(1);
                        len = parts[1].length;
                        if (parts[1] && parts[1][len - 1] == '"') parts[1] = parts[1].substring(0, len - 1);
                    }
                    if (parts[1] && parts[1][0] == "'") {
                        parts[1] = parts[1].substring(1);
                        len = parts[1].length;
                        if (parts[1] && parts[1][len - 1] == "'") parts[1] = parts[1].substring(0, len - 1);
                    }

                    if (parts[1]) parts[1] = parts[1].trim();
                    parts[0] = parts[0].trim();
                    if (parts[0] == 'state.id') {
                        filterStates.push({attr: parts[0], value: parts[1].trim()});
                        _enums[i] = null;
                    } else {
                        _enums[i] = {attr: parts[0].trim(), value: parts[1].trim()};
                    }
                }

                name = name.trim();
                if (name == 'channel' || name == 'device') {
                    // Fill channels
                    if (!channels || !devices) {
                        channels = {};
                        devices  = {};
                        for (var _id in objects) {
                            if (objects[_id].type == 'state') {
                                parts = _id.split('.');
                                parts.pop();
                                var chn = parts.join('.');

                                parts.pop();
                                var dev =  parts.join('.');

                                devices[dev] = devices[dev] || [];
                                devices[dev].push(_id);

                                channels[chn] = channels[chn] || [];
                                channels[chn].push(_id);
                            }
                        }
                    }
                }

                var res = [];
                var resIndex = 0;
                var id;
                var s;
                var pass;
                if (name == 'channel') {
                    for (id in channels) {
                        if (!objects[id]) {
                            continue;
                        }
                        pass = true;
                        for (var c = 0; c < commons.length; c++) {
                            if (!commons[c]) continue;
                            if (!commons[c].r && commons[c].value) commons[c].r = generateRegExp(commons[c].value);
                            if (commons[c].attr == 'id') {
                                if (!commons[c].r || commons[c].r.test(id)) continue;
                            } else if (objects[id].common) {
                                if (commons[c].value === undefined && objects[id].common[commons[c].attr] !== undefined) continue;
                                if (!commons[c].r || commons[c].r.test(objects[id].common[commons[c].attr])) continue;
                            }
                            pass = false;
                            break;
                        }
                        if (!pass) continue;
                        for (var n = 0; n < natives.length; n++) {
                            if (!natives[n]) continue;
                            if (!natives[n].r && natives[n].value) natives[n].r = generateRegExp(natives[n].value);
                            if (natives[n].attr == 'id') {
                                if (!natives[n].r || natives[n].r.test(id)) continue;
                            } else if (objects[id].native) {
                                if (natives[n].value === undefined && objects[id].native[natives[n].attr] !== undefined) continue;
                                if (!natives[n].r || natives[n].r.test(objects[id].native[natives[n].attr])) continue;
                            }
                            pass = false;
                            break;
                        }
                        if (!pass) continue;

                        if (_enums.length) {
                            var enumIds = [];
                            var enumNames = [];
                            getObjectEnumsSync(id, enumIds, enumNames);

                            for (var m = 0; m < _enums.length; m++) {
                                if (!_enums[m] && !enums[m].value) continue;

                                var rID = generateRegExp(_enums[m].value, "enum." + _enums[m].attr + ".");
                                var rName = generateRegExp(_enums[m].value);

                                var enum_pass = false;
                                if(rID){
                                    enumIds.forEach( function(enumId){
                                        if(rID.test(enumId)){
                                            enum_pass = true;
                                            return;
                                        }
                                    })
                                }

                                if(rName){
                                    enumNames.forEach(function(enumName){
                                        if(rName.test(enumName)){
                                            enum_pass = true;
                                            return;
                                        }
                                    });
                                }

                                if (enum_pass) continue;
                                pass = false;
                                break;
                            }
                            if (!pass) continue;
                        }

                        // Add all states of this channel to list
                        for (s = 0; s < channels[id].length; s++) {
                            if (filterStates.length) {
                                pass = true;
                                for (var st = 0; st < filterStates.length; st++) {
                                    if (!filterStates[st].r && filterStates[st].value) {
                                        filterStates[st].r = generateRegExp(filterStates[st].value);
                                    }
                                    if (!filterStates[st].r || filterStates[st].r.test(channels[id][s])) continue;
                                    pass = false;
                                    break;
                                }
                                if (!pass) continue;
                            }
                            res.push(channels[id][s]);
                        }
                    }
                } else if (name == 'device') {
                    for (id in devices) {
                        if (!objects[id]) {
                            console.log(id);
                            continue;
                        }
                        pass = true;
                        for (var _c = 0; _c < commons.length; _c++) {
                            if (!commons[_c]) continue;
                            if (!commons[_c].r && commons[_c].value) commons[_c].r = generateRegExp(commons[_c]);
                            if (commons[_c].attr == 'id') {
                                if (!commons[_c].r || commons[_c].r.test(id)) continue;
                            } else if (objects[id].common) {
                                if (commons[_c].value === undefined && objects[id].common[commons[_c].attr] !== undefined) continue;
                                if (!commons[_c].r || commons[_c].r.test(objects[id].common[commons[_c].attr])) continue;
                            }
                            pass = false;
                            break;
                        }
                        if (!pass) continue;
                        for (var n = 0; n < natives.length; n++) {
                            if (!natives[n]) continue;
                            if (!natives[n].r && natives[n].value) natives[n].r = generateRegExp(natives[n].value);
                            if (natives[n].attr == 'id') {
                                if (!natives[n].r || natives[n].r.test(id)) continue;
                            } else if (objects[id].native) {
                                if (natives[n].value === undefined && objects[id].native[natives[n].attr] !== undefined) continue;
                                if (!natives[n].r || natives[n].r.test(objects[i].native[natives[n].attr])) continue;
                            }
                            pass = false;
                            break;
                        }
                        if (!pass) continue;

                        if (_enums.length) {
                            var enumIds = [];
                            var enumNames = [];
                            getObjectEnumsSync(id, enumIds, enumNames);

                            for (var m = 0; m < _enums.length; m++) {
                                if (!_enums[m] && !enums[m].value) continue;

                                var rID = generateRegExp(_enums[m].value, "enum." + _enums[m].attr + ".");
                                var rName = generateRegExp(_enums[m].value);

                                var enum_pass = false;
                                if(rID){
                                    enumIds.forEach( function(enumId){
                                        if(rID.test(enumId)){
                                            enum_pass = true;
                                            return;
                                        }
                                    })
                                }

                                if(rName){
                                    enumNames.forEach(function(enumName){
                                        if(rName.test(enumName)){
                                            enum_pass = true;
                                            return;
                                        }
                                    });
                                }

                                if (enum_pass) continue;
                                pass = false;
                                break;
                            }
                            if (!pass) continue;
                        }

                        // Add all states of this channel to list
                        for (s = 0; s < devices[id].length; s++) {
                            if (filterStates.length) {
                                pass = true;
                                for (var st = 0; st < filterStates.length; st++) {
                                    if (!filterStates[st].r && filterStates[st].value) {
                                        filterStates[st].r = generateRegExp(filterStates[st].value);
                                    }
                                    if (!filterStates[st].r || filterStates[st].r.test(devices[id][s])) continue;
                                    pass = false;
                                    break;
                                }
                                if (!pass) continue;
                            }
                            res.push(devices[id][s]);
                        }
                    }
                } else {
                    var r = (name && name != 'state') ? generateRegExp(name) : null;

                    // state
                    for (id in states) {
                        if (r && !r.test(id)) continue;
                        pass = true;

                        if (commons.length) {
                            for (var c = 0; c < commons.length; c++) {
                                if (!commons[c]) continue;
                                if (!commons[c].r && commons[c].value) commons[c].r = generateRegExp(commons[c].value);
                                if (commons[c].attr == 'id') {
                                    if (!commons[c].r || commons[c].r.test(id)) continue;
                                } else if (objects[id].common) {
                                    if (commons[c].value === undefined && objects[id].common[commons[c].attr] !== undefined) continue;
                                    if (!commons[c].r || commons[c].r.test(objects[id].common[commons[c].attr])) continue;
                                }
                                pass = false;
                                break;
                            }
                            if (!pass) continue;
                        }
                        if (natives.length) {
                            for (var n = 0; n < natives.length; n++) {
                                if (!natives[n]) continue;
                                if (!natives[n].r && natives[n].value) natives[id].r = generateRegExp(natives[n].value);
                                if (natives[n].attr == 'id') {
                                    if (!natives[n].r || natives[n].r.test(id)) continue;
                                } else if (objects[id].native) {
                                    if (natives[n].value === undefined && objects[id].native[natives[n].attr] !== undefined) continue;
                                    if (!natives[n].r || natives[n].r.test(objects[id].native[natives[n].attr])) continue;
                                }
                                pass = false;
                                break;
                            }
                            if (!pass) continue;
                        }

                        if (filterStates.length) {
                            for (var st = 0; st < filterStates.length; st++) {
                                if (!filterStates[st].r && filterStates[st].value) {
                                    filterStates[st].r = generateRegExp(filterStates[st].value);
                                }
                                if (!filterStates[st].r || filterStates[st].r.test(id)) continue;
                                pass = false;
                                break;
                            }
                            if (!pass) continue;
                        }

                        if (_enums.length) {
                            var enumIds = [];
                            var enumNames = [];
                            getObjectEnumsSync(id, enumIds, enumNames);

                            for (var m = 0; m < _enums.length; m++) {
                                if (!_enums[m] && !enums[m].value) continue;

                                var rID = generateRegExp(_enums[m].value, "enum." + _enums[m].attr + ".");
                                var rName = generateRegExp(_enums[m].value);

                                var enum_pass = false;
                                if(rID){
                                    enumIds.forEach( function(enumId){
                                        if(rID.test(enumId)){
                                            enum_pass = true;
                                            return;
                                        }
                                    })
                                }

                                if(rName){
                                    enumNames.forEach(function(enumName){
                                        if(rName.test(enumName)){
                                            enum_pass = true;
                                            return;
                                        }
                                    });
                                }

                                if (enum_pass) continue;
                                pass = false;
                                break;
                            }
                            if (!pass) continue;
                        }
                        // Add all states of this channel to list
                        res.push(id);
                    }

                    // Now filter away by name
                }

                for (i = 0; i < res.length; i++) {
                    result[i] = res[i];
                }
                result.length = res.length;
                result.each = function (callback) {
                    for (var i = 0; i < this.length; i++) {
                        if (typeof callback == 'function') callback(result[i], i);
                    }
                    return this;
                };
                result.getState = function () {
                    if (this[0]) return states[this[0]];
                    
                    return null;
                };
                result.setState = function (state, isAck, callback) {
                    if (typeof isAck == 'function') {
                        callback = isAck;
                        isAck = undefined;
                    }

                    if (isAck === true || isAck === false || isAck === 'true' || isAck === 'false') {
                        if (typeof state == 'object') {
                            state.ack = isAck;
                        } else {
                            state = {val: state, ack: isAck};
                        }
                    }
                    var cnt = 0;
                    for (var i = 0; i < this.length; i++) {
                        cnt++;
                        adapter.setForeignState(this[i], state, function () {
                            cnt--;
                            if (!cnt && typeof callback === 'function') callback();
                        });
                    }
                    return this;
                };
                result.on = function (callbackOrId, value) {
                    for (var i = 0; i < this.length; i++) {
                        sandbox.subscribe(this[i], callbackOrId, value);
                    }
                    return this;
                };
                return result;
            },
            log:       function (msg, sev) {
                if (!sev) sev = 'info';
                if (!adapter.log[sev]) {
                    msg = 'Unknown severity level "' + sev + '" by log of [' + msg + ']';
                    sev = 'warn';
                }
                adapter.log[sev](name + ': ' + msg);
            },
            exec:      function (cmd, callback) {
                return mods.child_process.exec(cmd, callback);
            },
            email:     function (msg) {
                adapter.sendTo('email', msg);
            },
            pushover:  function (msg) {
                adapter.sendTo('pushover', msg);
            },
            subscribe: function (pattern, callbackOrId, value) {
                if (typeof pattern == 'object') {
                    if (pattern.astro) {
                        return sandbox.schedule(pattern, callbackOrId, value);
                    } else if (pattern.time) {
                        return sandbox.schedule(pattern.time, callbackOrId, value);
                    }
                }

                var callback;

                sandbox.__engine.__subscriptions += 1;

                if (typeof pattern !== 'object') {
                    pattern = {id: pattern, change: 'ne'};
                }

                // add adapter namespace if nothing given
                if (pattern.id && Object.prototype.toString.call(pattern.id)!="[object RegExp]" && pattern.id.indexOf('.') == -1) {
                    pattern.id = adapter.namespace + '.' + pattern.id;
                }

                if (typeof callbackOrId === 'function') {
                    callback = callbackOrId;
                } else {
                    var that = this;
                    if (typeof value === 'undefined') {
                        callback = function (obj) {
                            that.setState(callbackOrId, obj.newState.val);
                        };
                    } else {
                        callback = function (obj) {
                            that.setState(callbackOrId, value);
                        };
                    }
                }

                subscriptions.push({
                    pattern:  pattern,
                    callback: function (obj) {
                        if (callback) callback.call(sandbox, obj);
                    },
                    name:     name
                });
                if (pattern.enumName || pattern.enumId) isEnums = true;
            },
            on:        function (pattern, callbackOrId, value) {
                return sandbox.subscribe(pattern, callbackOrId, value);
            },
            schedule:  function (pattern, callback) {

                if (typeof callback !== 'function') {
                    adapter.log.error(name + ': schedule callback missing');
                    return;
                }

                sandbox.__engine.__schedules += 1;

                if (pattern.astro) {

                    var nowdate = new Date();

                    if (adapter.config.latitude === undefined || adapter.config.longitude === undefined) {
                        adapter.log.error('Longitude or latitude does not set. Cannot use astro.');
                        return;
                    }

                    var ts = mods.suncalc.getTimes(nowdate, adapter.config.latitude, adapter.config.longitude)[pattern.astro];

                    if (ts.getTime().toString() === 'NaN') {
                        adapter.log.warn('Cannot calculate "' + pattern.astro + '" for ' + adapter.config.latitude + ', ' + adapter.config.longitude);
                        ts = new Date(nowdate.getTime());

                        if (pattern.astro == 'sunriseEnd'       ||
                            pattern.astro == 'goldenHourEnd'    ||
                            pattern.astro == 'sunset'           ||
                            pattern.astro == 'nightEnd'         ||
                            pattern.astro == 'nauticalDusk') {
                            ts.setMinutes(59);
                            ts.setHours(23);
                            ts.setSeconds(59);
                        } else {
                            ts.setMinutes(59);
                            ts.setHours(23);
                            ts.setSeconds(58);
                        }
                    }

                    if (ts && pattern.shift) {
                        ts = new Date(ts.getTime() + (pattern.shift * 60000));
                    }

                    if (!ts || ts < nowdate) {
                        var date = new Date(nowdate);
                        // Event doesn't occur today - try again tomorrow
                        // Calculate time till 24:00 and set timeout
                        date.setDate(date.getDate() + 1);
                        date.setMinutes(1); // Somtimes timer fires at 23:59:59
                        date.setHours(0);
                        date.setSeconds(0);
                        date.setMilliseconds(0);
                        date.setMinutes(-date.getTimezoneOffset());


                        // Calculate new schedule in the next day
                        sandbox.setTimeout(function () {
                             if (sandbox.__engine.__schedules > 0) sandbox.__engine.__schedules--;

                            sandbox.schedule(pattern, callback);
                        }, date.getTime() - nowdate.getTime());

                        return;
                    }

                    sandbox.setTimeout(function () {
                        callback.call(sandbox);
                        // Reschedule in 2 seconds
                        sandbox.setTimeout(function () {
                            if (sandbox.__engine.__schedules > 0) sandbox.__engine.__schedules--;
                            sandbox.schedule(pattern, callback);
                        }, 2000);

                    }, ts.getTime() - nowdate.getTime());
                } else {
                    // fix problem with sunday and 7
                    if (typeof pattern == 'string') {
                        var parts = pattern.replace(/\s+/g, ' ').split(' ');
                        if (parts.length >= 5 && parts[5] >= 7) parts[5] = 0;
                        pattern = parts.join(' ');
                    }

                    script.schedules.push(mods['node-schedule'].scheduleJob(pattern, function () {
                        callback.call(sandbox);
                    }));
                }
            },
            setState:  function (id, state, isAck, callback) {
                if (typeof isAck == 'function') {
                    callback = isAck;
                    isAck = undefined;
                }

                if (isAck === true || isAck === false || isAck === 'true' || isAck === 'false') {
                    if (typeof state == 'object') {
                        state.ack = isAck;
                    } else {
                        state = {val: state, ack: isAck};
                    }
                }

                if (states[id]) {
                    adapter.setForeignState(id, state, function () {
                        if (typeof callback === 'function') callback();
                    });
                } else if (states[adapter.namespace + '.' + id]) {
                    adapter.setState(id, state, function () {
                        if (typeof callback === 'function') callback();
                    });
                } else {
                    adapter.log.warn('State "' + id + '" not found');
                    if (typeof callback === 'function') callback('State "' + id + '" not found');
                }
            },
            getState:  function (id) {
                if (states[id]) return states[id];
                if (states[adapter.namespace + '.' + id]) return states[adapter.namespace + '.' + id];
                adapter.log.warn('State "' + id + '" not found');
                return null;
            },
            getObject: function (id, object_type) {
                return getObjectUp(id, object_type);
            },
            createState: function (name, initValue, forceCreation, common, native, callback) {
                if (typeof native == 'function') {
                    callback  = native;
                    native = {};
                }
                if (typeof common == 'function') {
                    callback  = common;
                    common = undefined;
                }
                if (typeof initValue == 'function') {
                    callback  = initValue;
                    initValue = undefined;
                }
                if (typeof forceCreation == 'function') {
                    callback  = forceCreation;
                    forceCreation = undefined;
                }
                if (typeof initValue == 'object') {
                    common = initValue;
                    native = forceCreation
                    forceCreation = undefined;
                    initValue = undefined;
                }
                if (typeof forceCreation == 'object') {
                    common = forceCreation;
                    native = common
                    forceCreation = undefined;
                }
                common = common || {};
                common.name = common.name || name;
                common.role = common.role || 'javascript';
                common.type = common.type || 'mixed';

                native = native || {}

                if (forceCreation) {
                    adapter.setObject(name, {
                        common: common,
                        native: native,
                        type:   'state'
                    }, function () {
                        if (initValue !== undefined) {
                            adapter.setState(name, initValue, callback);
                        } else {
                            if (callback) callback(name);
                        }
                    });
                } else {
                    adapter.getObject(name, function (err, obj) {
                        if (err || !obj) {
                            adapter.setObject(name, {
                                common: common,
                                native: native,
                                type: 'state'
                            }, function () {
                                if (initValue !== undefined) {
                                    adapter.setState(name, initValue, callback);
                                } else {
                                    if (callback) callback(name);
                                }
                            });
                        } else {
                            // state yet exists
                            if (callback) callback(name);
                        }
                    });
                }
            },
            sendTo:    function (_adapter, cmd, msg, callback) {
                adapter.sendTo(_adapter, cmd, msg, callback);
            },
            sendto:    function (_adapter, cmd, msg, callback) {
                return sandbox.sendTo(_adapter, cmd, msg, callback);
            },
            setInterval:   function (callback, ms, arg1, arg2, arg3, arg4) {
                var int = setInterval(function (_arg1, _arg2, _arg3, _arg4) {
                    if (callback) callback.call(sandbox, _arg1, _arg2, _arg3, _arg4);
                }, ms, arg1, arg2, arg3, arg4);
                script.intervals.push(int);
                return int;
            },
            clearInterval: function (id) {
                var pos = script.intervals.indexOf(id);
                if (pos != -1) {
                    clearInterval(id);
                    script.intervals.splice(pos, 1);
                }
            },
            setTimeout:    function (callback, ms, arg1, arg2, arg3, arg4) {
                var to = setTimeout(function (_arg1, _arg2, _arg3, _arg4) {
                    // Remove timeout from the list
                    var pos = script.timeouts.indexOf(to);
                    if (pos != -1) script.timeouts.splice(pos, 1);

                    if (callback) callback.call(sandbox, _arg1, _arg2, _arg3, _arg4);
                }, ms, arg1, arg2, arg3, arg4);
                script.timeouts.push(to);
                return to;
            },
            clearTimeout:  function (id) {
                var pos = script.timeouts.indexOf(id);
                if (pos != -1) {
                    clearTimeout(id);
                    script.timeouts.splice(pos, 1);
                }
            },
            cb:        function (callback) {
                return function () {
                    if (scripts[name] && scripts[name]._id == sandbox._id) {
                        if (callback) callback.apply(this, arguments);
                    } else {
                        adapter.log.warn('Callback for old version of script: ' + name);
                    }
                };
            },
            formatDate: function (date, format, isDataObject) {
                if (typeof format == 'boolean') {
                    isDataObject = format;
                    format = null;
                }

                if (!format) {
                    format = objects['system.config'] ? (objects['system.config'].common.dateFormat || 'DD.MM.YYYY') : 'DD.MM.YYYY';
                }

                return adapter.formatDate(date, !isDataObject, format);
            },
            writeFile: function (fileName, data, callback) {
                adapter.writeFile(null, fileName, data, callback);
            },
            readFile: function (fileName, callback) {
                adapter.readFile(null, fileName, callback);
            },
            toInt: function (val) {
                if (val === true  || val === 'true')  val = 1;
                if (val === false || val === 'false') val = 0;
                val = parseInt(val) || 0;
                return val;
            },
            toFloat: function (val) {
                if (val === true  || val === 'true')  val = 1;
                if (val === false || val === 'false') val = 0;
                val = parseFloat(val) || 0;
                return val;
            },
            toBoolean: function (val) {
                if (val === '1' || val === 'true')  val = true;
                if (val === '0' || val === 'false') val = false;
                return !!val;
            }
        };

        try {
            script.runInNewContext(sandbox);
        } catch (e) {
            var lines = e.stack.split('\n');
            var stack = [];
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].match(/runInNewContext/)) break;
                stack.push(lines[i]);
            }
            adapter.log.error(name + ': ' + stack.join('\n'));
        }
    }

    function stop(name, callback) {
        adapter.log.info('Stop script ' + name);
        if (scripts[name]) {
            // Remove from subscriptions
            isEnums = false;
            for (var i = subscriptions.length - 1; i >= 0 ; i--) {
                if (subscriptions[i].name == name) {
                    subscriptions.splice(i, 1);
                } else {
                    if (!isEnums && subscriptions[i].pattern.enumName || subscriptions[i].pattern.enumId) isEnums = true;
                }
            }
            // Stop all timeouts
            for (i = 0; i < scripts[name].timeouts.length; i++) {
                clearTimeout(scripts[name].timeouts[i]);
            }
            // Stop all intervals
            for (i = 0; i < scripts[name].intervals.length; i++) {
                clearInterval(scripts[name].intervals[i]);
            }
            // Stop all scheduled jobs
            for (i = 0; i < scripts[name].schedules.length; i++) {
                var _name = scripts[name].schedules[i].name;
                if (!mods['node-schedule'].cancelJob(scripts[name].schedules[i])) {
                    adapter.log.error('Error by canceling scheduled job "' + _name + '"');
                }
            }
            delete scripts[name];
            if (callback) callback(true, name);
        } else {
            if (callback) callback(false, name);
        }
    }

    function load(name, callback) {

        adapter.getForeignObject(name, function (err, obj) {
            if (!err && obj && obj.common.enabled && obj.common.engine === 'system.adapter.' + adapter.namespace && obj.common.source && obj.common.engineType.match(/^[jJ]ava[sS]cript/)) {
                // Javascript
                adapter.log.info('Start javascript ' + name);
                scripts[name] = compile(globalScript + obj.common.source, name);
                if (scripts[name]) execute(scripts[name], name);
                if (callback) callback(true, name);
            } else if (!err && obj && obj.common.enabled && obj.common.engine === 'system.adapter.' + adapter.namespace && obj.common.source && obj.common.engineType.match(/^[cC]offee/)) {
                // CoffeeScript
                mods['coffee-compiler'].fromSource(obj.common.source, {sourceMap: false, bare: true}, function (err, js) {
                    if (err) {
                        adapter.log.error(name + ' coffee compile ' + err);
                        if (callback) callback(false, name);
                        return;
                    }
                    adapter.log.info('Start coffescript ' + name);
                    scripts[name] = compile(globalScript + js, name);
                    if (scripts[name]) execute(scripts[name], name);
                    if (callback) callback(true, name);
                });
            } else {
                if (callback) callback(false, name);
            }
        });

    }

    function patternMatching(event, pattern) {

        if (!pattern.logic) {
            pattern.logic = "and";
        }

        var matched = false;

        // state id matching
        if (pattern.id) {
            if (event.id && event.id.match(generateRegExp(pattern.id))) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }

        // state name matching
        if (pattern.name) {
            if (event.common.name && event.common.name.match(generateRegExp(pattern.name))) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }

        // todo anchestor name matching

        // change matching
        if (pattern.change) {
            switch (pattern.change) {
                case "eq":
                    if (event.newState.val === event.oldState.val) {
                        if (pattern.logic === "or") return true;
                        matched = true;
                    } else {
                        if (pattern.logic === "and") return false;
                    }
                    break;
                case "ne":
                    if (event.newState.val !== event.oldState.val) {
                        if (pattern.logic === "or") return true;
                        matched = true;
                    } else {
                        if (pattern.logic === "and") return false;
                    }
                    break;
                case "gt":
                    if (event.newState.val > event.oldState.val) {
                        if (pattern.logic === "or") return true;
                        matched = true;
                    } else {
                        if (pattern.logic === "and") return false;
                    }
                    break;
                case "ge":
                    if (event.newState.val >= event.oldState.val) {
                        if (pattern.logic === "or") return true;
                        matched = true;
                    } else {
                        if (pattern.logic === "and") return false;
                    }
                    break;
                case "lt":
                    if (event.newState.val < event.oldState.val) {
                        if (pattern.logic === "or") return true;
                        matched = true;
                    } else {
                        if (pattern.logic === "and") return false;
                    }
                    break;
                case "le":
                    if (event.newState.val <= event.oldState.val) {
                        if (pattern.logic === "or") return true;
                        matched = true;
                    } else {
                        if (pattern.logic === "and") return false;
                    }
                    break;
                default:
                    // on any other logic, just signal about message
                    if (pattern.logic === "or") return true;
                    matched = true;
                    break;
            }
        }

        // Ack Matching
        if (pattern.ack !== undefined) {
            if (((pattern.ack === 'true'  || pattern.ack === true)  && (event.newState.ack === true  || event.newState.ack === 'true')) ||
                ((pattern.ack === 'false' || pattern.ack === false) && (event.newState.ack === false || event.newState.ack === 'false'))) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }

        // oldAck Matching
        if (pattern.oldAck !== undefined) {
            if (((pattern.oldAck === 'true'  || pattern.oldAck === true)  && (event.oldState.ack === true  || event.oldState.ack === 'true')) ||
                ((pattern.oldAck === 'false' || pattern.oldAck === false) && (event.oldState.ack === false || event.oldState.ack === 'false'))) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }

        // Value Matching
        if (pattern.val !== undefined && pattern.val === event.newState.val) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.val !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.valGt !== undefined && event.newState.val > pattern.valGt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.valGt !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.valGe !== undefined && event.newState.val >= pattern.valGe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.valGe !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.valLt !== undefined && event.newState.val < pattern.valLt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.valLt !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.valLe !== undefined && event.newState.val <= pattern.valLe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.valLe !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.valNe !== undefined && event.newState.val !== pattern.valNe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.valNe !== undefined) {
            if (pattern.logic === "and") return false;
        }

        // Old-Value matching
        if (pattern.oldVal !== undefined && pattern.oldVal === event.oldState.val) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldVal !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldValGt !== undefined && event.oldState.val > pattern.oldValGt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldValGt !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldValGe !== undefined && event.oldState.val >= pattern.oldValGe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldValGe !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldValLt !== undefined && event.oldState.val < pattern.oldValLt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldValLt !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldValLe !== undefined && event.oldState.val <= pattern.oldValLe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldValLe !== undefined) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldValNe !== undefined && event.oldState.val !== pattern.oldValNe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldValNe !== undefined) {
            if (pattern.logic === "and") return false;
        }

        // newState.ts matching
        if (pattern.ts && pattern.ts === event.newState.ts) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.ts) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.tsGt && event.newState.ts > pattern.tsGt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.tsGt) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.tsGe && event.newState.ts >= pattern.tsGe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.tsGe) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.tsLt && event.newState.ts < pattern.tsLt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.tsLt) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.tsLe && event.newState.ts <= pattern.tsLe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.tsLe) {
            if (pattern.logic === "and") return false;
        }

        // oldState.ts matching
        if (pattern.oldTs && pattern.oldTs === event.oldState.ts) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldTs) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldTsGt && event.oldState.ts > pattern.oldTsGt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldTsGt) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldTsGe && event.oldState.ts >= pattern.oldTsGe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldTsGe) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldTsLt && event.oldState.ts < pattern.oldTsLt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldTsLt) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldTsLe && event.oldState.ts <= pattern.oldTsLe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldTsLe) {
            if (pattern.logic === "and") return false;
        }

        // newState.lc matching
        if (pattern.lc && pattern.lc === event.newState.lc) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.lc) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.lcGt && event.newState.lc > pattern.lcGt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.lcGt) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.lcGe && event.newState.lc >= pattern.lcGe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.lcGe) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.lcLt && event.newState.lc < pattern.lcLt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.lcLt) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.lcLe && event.newState.lc <= pattern.lcLe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.lcLe) {
            if (pattern.logic === "and") return false;
        }

        // oldState.lc matching
        if (pattern.oldLc && pattern.oldLc === event.oldState.lc) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldLc) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldLcGt && event.oldState.lc > pattern.oldLcGt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldLcGt) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldLcGe && event.oldState.lc >= pattern.oldLcGe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldLcGe) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldLcLt && event.oldState.lc < pattern.oldLcLt) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldLcLt) {
            if (pattern.logic === "and") return false;
        }
        if (pattern.oldLcLe && event.oldState.lc <= pattern.oldLcLe) {
            if (pattern.logic === "or") return true;
            matched = true;
        } else if (pattern.oldLcLe) {
            if (pattern.logic === "and") return false;
        }

        // newState.from matching
        if (pattern.from && pattern.from === event.newState.from) {
            if (pattern.logic == "or") return true;
            matched = true;
        } else if (pattern.from) {
            if (pattern.logic == "and") return false;
        }

        if (pattern.fromNe && pattern.fromNe !== event.newState.from) {
            if (pattern.logic == "or") return true;
            matched = true;
        } else if (pattern.fromNe) {
            if (pattern.logic == "and") return false;
        }

        // oldState.from matching
        if (pattern.oldFrom && pattern.oldFrom === event.oldState.from) {
            if (pattern.logic == "or") return true;
            matched = true;
        } else if (pattern.oldFrom) {
            if (pattern.logic == "and") return false;
        }

        if (pattern.oldFromNe && pattern.oldFromNe !== event.oldState.from) {
            if (pattern.logic == "or") return true;
            matched = true;
        } else if (pattern.oldFromNe) {
            if (pattern.logic == "and") return false;
        }

        // channelId matching
        if (pattern.channelId) {
            if (event.channelId && event.channelId.match(generateRegExp(pattern.channelId))) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }

        // channelName matching
        if (pattern.channelName) {
            if (event.channelName && event.channelName.match(generateRegExp(pattern.channelName))) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }

        // deviceId matching
        if (pattern.deviceId) {
            if (event.deviceId && event.deviceId.match(generateRegExp(pattern.deviceId))) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }

        // deviceName matching
        if (pattern.deviceName) {
            if (event.deviceName && event.deviceName.match(generateRegExp(pattern.deviceName))) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }
        var subMatched;

        // enumIds matching
        if (pattern.enumId) {
            subMatched = false;
            for (var i = 0; i < event.enumIds.length; i++) {
                if (event.enumIds[i].match(generateRegExp(pattern.enumId))) {
                    subMatched = true;
                    break;
                }
            }
            if (subMatched) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }

        // enumNames matching
        if (pattern.enumName) {
            subMatched = false;
            for (var j = 0; j < event.enumNames.length; j++) {
                if (event.enumNames[j].match(generateRegExp(pattern.enumName))) {
                    subMatched = true;
                    break;
                }
            }
            if (subMatched) {
                if (pattern.logic === "or") return true;
                matched = true;
            } else {
                if (pattern.logic === "and") return false;
            }
        }


        return matched;

    }

    function getData(callback) {
        var statesReady;
        var objectsReady;
        adapter.log.info('requesting all states');
        adapter.getForeignStates('*', function (err, res) {
            states = res;
            statesReady = true;
            adapter.log.info('received all states');
            if (objectsReady && typeof callback === 'function') callback();
        });
        adapter.log.info('requesting all objects');

        adapter.objects.getObjectList({include_docs: true}, function (err, res) {
            res = res.rows;
            objects = {};
            for (var i = 0; i < res.length; i++) {
                objects[res[i].doc._id] = res[i].doc;
                if (res[i].doc.type === 'enum') enums.push(res[i].doc._id);
            }

            objectsReady = true;
            adapter.log.info('received all objects');
            if (statesReady && typeof callback === 'function') callback();
        });
    }

    function getObjectEnums(idObj, callback, enumIds, enumNames) {
        if (!enumIds)   enumIds   = [];
        if (!enumNames) enumNames = [];

        if (cacheObjectEnums[idObj]) {
            if (typeof callback === 'function') {
                for (var j = 0; j < cacheObjectEnums[idObj].enumIds.length; j++) {
                    if (enumIds.indexOf(cacheObjectEnums[idObj].enumIds[j]) == -1) enumIds.push(cacheObjectEnums[idObj].enumIds[j]);
                }
                for (j = 0; j < cacheObjectEnums[idObj].enumNames.length; j++) {
                    if (enumNames.indexOf(cacheObjectEnums[idObj].enumNames[j]) == -1) enumNames.push(cacheObjectEnums[idObj].enumNames[j]);
                }

                callback(cacheObjectEnums[idObj].enumIds, cacheObjectEnums[idObj].enumNames);
            }
            return;
        }

        for (var i = 0, l = enums.length; i < l; i++) {
            if (objects[enums[i]] &&
                objects[enums[i]].common &&
                objects[enums[i]].common.members &&
                objects[enums[i]].common.members.indexOf(idObj) !== -1) {
                if (enumIds.indexOf(enums[i]) == -1) enumIds.push(enums[i]);
                if (enumNames.indexOf(objects[enums[i]].common.name) == -1) enumNames.push(objects[enums[i]].common.name);
            }
        }
        if (objects[idObj]) {
            var pos = idObj.lastIndexOf('.');
            if (pos != -1) {
                var parent = idObj.substring(0, pos);
                if (parent && objects[parent]) {
                    return getObjectEnums(parent, callback, enumIds, enumNames);
                }
            }
        }

        cacheObjectEnums[idObj] = {enumIds: enumIds, enumNames: enumNames};
        if (typeof callback === 'function') callback(enumIds, enumNames);
    }

    function getObjectEnumsSync(idObj, enumIds, enumNames) {
        if (!enumIds)   enumIds   = [];
        if (!enumNames) enumNames = [];

        if (cacheObjectEnums[idObj]) {
            for (var j = 0; j < cacheObjectEnums[idObj].enumIds.length; j++) {
                if (enumIds.indexOf(cacheObjectEnums[idObj].enumIds[j]) == -1) enumIds.push(cacheObjectEnums[idObj].enumIds[j]);
            }
            for (j = 0; j < cacheObjectEnums[idObj].enumNames.length; j++) {
                if (enumNames.indexOf(cacheObjectEnums[idObj].enumNames[j]) == -1) enumNames.push(cacheObjectEnums[idObj].enumNames[j]);
            }
            return;
        }


        for (var i = 0, l = enums.length; i < l; i++) {
            if (objects[enums[i]] &&
                objects[enums[i]].common &&
                objects[enums[i]].common.members &&
                objects[enums[i]].common.members.indexOf(idObj) !== -1) {
                if (enumIds.indexOf(enums[i]) == -1) enumIds.push(enums[i]);
                if (enumNames.indexOf(objects[enums[i]].common.name) == -1) enumNames.push(objects[enums[i]].common.name);
            }
        }

        if (objects[idObj]) {
            var pos = idObj.lastIndexOf('.');
            if (pos != -1) {
                var parent = idObj.substring(0, pos);
                if (parent && objects[parent]) {
                    return getObjectEnumsSync(parent, enumIds, enumNames);
                }
            }
        }

        cacheObjectEnums[idObj] = {enumIds: enumIds, enumNames: enumNames};
        return cacheObjectEnums[idObj];
    }
    
    function getObjectUp(id, object_type){
        if(objects[id]){
            if(object_type==null || objects[id].type==object_type)
                return objects[id];
            else{
                var obj = objects[id];
                var obj_id = id;
                var parts = obj_id.split('.');
                                        
                while(parts.length>0){
                    parts.pop();
                    obj_id = parts.join('.');
                    obj = objects[obj_id];
                    
                    if(!obj || obj.type==object_type)
                        break;
                    else{   
                        parts = obj_id.split('.');
                        obj = null;
                    }
                }
                
                return obj;
            }
        }
        
        return null;
    }

    function generateRegExp(filter, prefix, suffix){
        prefix = prefix || "";
        suffix = suffix || "";

        if (Object.prototype.toString.call(filter) == '[object RegExp]')
            return filter;

        var regParts = filter.match(/^\/(.*?)\/([gim]*)$/);
        if (regParts)
            return new RegExp(prefix.replace(/\./g,"\\.") + regParts[1] + suffix.replace(/\./g,"\\."), regParts[2]);

        if(filter[filter.length-1]!="*"){
            if(suffix!="")
                suffix += "$";
            else
                filter+= "$";
        }

        if(filter[0]!="*"){
            if(prefix!="")
                prefix = "^" + prefix;
            else
                filter="^" + filter;
        }

        filter=(prefix + filter + suffix).replace(/\./g,"\\.").replace(/\*/g, ".*");

        return new RegExp(filter);
    }
})();
