/* globals require, module */
/**
 * @module app/Kernel
 * @param {object} context
 * @property {string} context.functionName
 * @property {function} context.succeed
 * @property {function} context.fail
 * @param {object} event
 * @property {string} event.getdata
 * @property {string} event.postdata
 * @class
 */
function Kernel(context, event) {
    /** @constant {number} */
    this.kernelVersion = 1;
    this.context       = context;
    this.event         = event;

    this.mapValues     = {
        "%kernel%": this,
        "%context%": context,
        "%event%": event
    };

    //Since the Kernel Masquerades as context, we need to copy just it's variables to it, functions have been mapped to the context object.
    for (var attr in JSON.parse(JSON.stringify(context))) {
        if (context.hasOwnProperty(attr)) {
            this[attr] = context[attr];
        }
    }

    var qs            = require('qs');
    this.request      = {
        "get" : "",
        "post": "",
        "all" : function() {
            var data   = [
                (this.get) ? JSON.stringify(this.get)
                                 .trim() : '',
                (this.post) ? JSON.stringify(this.post)
                                  .trim() : ''
            ];
            var result = data.filter(Boolean)
                             .join('|')
                             .replace("}|{", ",");
            return (result) ? JSON.parse(result) : false;
        }
    };

    this.request.get  = (typeof event.getdata  !== 'undefined' && event.getdata.trim()  !== '') ? qs.parse(event.getdata)  : false;
    this.request.post = (typeof event.postdata !== 'undefined' && event.postdata.trim() !== '') ? qs.parse(event.postdata) : false;

    var winston       = require('winston');
    this.logger       = new (winston.Logger)({
        transports: [
            new (winston.transports.Console)({
                timestamp: function() {
                    return Date.now();
                },
                formatter: function(options) {
                    return '[' + options.level.toUpperCase() + '] ' + (undefined !== options.message ? options.message : '') + (options.meta && Object.keys(options.meta).length ? '\n\t' + JSON.stringify(options.meta) : '' );
                }
            })
        ]
    });

    this.logger.setLevels(winston.config.syslog.levels);

    /*
     We try to grab the environment from event stage then from the function name, if those faile we set to DEFAULT.
     */
    var nameArray     = (0 <= context.functionName.indexOf('-')) ? context.functionName.split('-') : [
        context.functionName, 'DEFAULT'
    ];
    var environment   = (typeof event.stage !== 'undefined') ? event.stage : nameArray[1];
    this.functionName = nameArray[0];
    this.loadEnvironment(environment);
    this.loadServices();
}

Kernel.prototype.returnResult = 'SUCCESS';

/**
 * @function loadEnvironment
 * Set the environment and load the config based on the environment
 * @param {string} environment
 */
Kernel.prototype.loadEnvironment = function loadEnvironment(environment) {
    this.environment = environment.toUpperCase();
    var path         = String('../etc/' + this.environment)
        .replace('/DEFAULT', '');
    this.config      = require(path);
    if ('DEFAULT' == environment && 'undefined' !== typeof this.config.environment && 'DEFAULT' !== this.config.environment) {
        this.loadEnvironment(this.config.environment);
    } else {
        this.config.succeedFails = (typeof this.config.succeedFails !== 'undefined') ? this.config.succeedFails : false;
        var logLevel             = this.config.logLevel || 'error';
        this.setLogLevel(logLevel);
        this.log('Set environment to: ' + this.environment);
    }
};

Kernel.prototype.loadServices = function loadServices() {
    this.services = require('../etc/services');
};

Kernel.prototype.getService = function getService(serviceName) {
    var path = ('undefined' !== typeof this.services[serviceName]) ? '..' + this.services[serviceName].path : serviceName;
    var service = require(path);
    var arguments = this.services[serviceName].arguments || [];
    var commands  = this.services[serviceName].commands || [];
    var instance = Object.create(service.prototype);

    var argumentFilter = function(array, that) {
        return array.map(function(value) {
            return (typeof this.mapValues[value] !== "undefined") ? this.mapValues[value] : value;
        }, that);
    };

    if (arguments.length > 0) {
        service.apply(instance, argumentFilter(arguments, this))
    } else {
        instance = new service;
    }

    if(commands.length > 0) {
        commands.map(function(value){
            switch(typeof value) {
                case "object":
                    var func = instance[value["name"]];
                    if (value["arguments"].length > 0) {
                        func.apply(instance, argumentFilter(value["arguments"], this));
                    } else {
                        instance[value["name"]]();
                    }
                    break;
                case "string":
                    instance[value]();
                    break;
                case "default":
                    this.log("Unknown Command Definition: Expecting String(\"Function Name\") or Object({\"name\":\"Function Name\", \"arguments\":[<<Function Arguments>>]}).", "alert");
            }
        }, this);
    }

    return instance;
};

/**
 * Set the log level
 * @param {string} level
 */
Kernel.prototype.setLogLevel = function setLogLevel(level) {
    level = level.toLowerCase();
    if (typeof this.logger.levels[level] == "undefined") {
        this.logger.error("No such Log Level: " + level);
    } else {
        this.config.logLevel = level;
        this.logger.level    = this.config.logLevel;
    }
};

/**
 * @param {string} message
 * @param {string} [level]
 */
Kernel.prototype.log = function log(message, level) {
    level = level || 'info';
    level = level.toLowerCase();
    if (typeof this.logger.levels[level] == "undefined") {
        message = "No such Log Level: " + level;
        level   = 'error';
    }

    if (typeof message === 'object') {
        message = JSON.stringify(message);
    }
    this.logger.log(level, message);
};

/**
 * Overrides existing setting. Tells error handler whether or not to context.succeed failures.
 * @param {boolean} succeedFails
 */
Kernel.prototype.setSucceedFails = function setSucceedFails(succeedFails) {
    this.config.succeedFails = succeedFails;
};

/**
 *
 * @param {(string|object)} [err]
 * @param {(string|object)} [result]
 */
Kernel.prototype.done = function done(err, result) {
    var isSuccess     = true;
    var logLevel      = 'debug';
    this.returnResult = result || this.returnResult;

    if (err) {
        if (typeof err === 'object') {
            err = err.stack + JSON.stringify(err);
        }
        this.returnResult = err;
        logLevel          = 'crit';
        isSuccess         = false;
    }

    this.log(this.returnResult, logLevel);
    //context.fail forces lambda to try 2 or 3 more times.
    //if succeedFails is true, we go ahead and succeed and handle the failure elsewhere.
    if (this.config.succeedFails || isSuccess) {
        this.context.succeed(this.returnResult);
    } else {
        this.context.fail(this.returnResult);
    }
};

/**
 *
 * @param {(string|object)} [result]
 */
Kernel.prototype.succeed = function succeed(result) {
    this.done(false, result);
};

/**
 *
 * @param {(string|object)} [err]
 */
Kernel.prototype.fail = function fail(err) {
    this.done(err);
};

Kernel.prototype.getRemainingTimeInMillis = function getRemainingTimeInMillis() {
    return this.context.getRemainingTimeInMillis();
};

Kernel.prototype.getRemainingTimeInSecs = function getRemainingTimeInSecs() {
    return Math.floor(this.context.getRemainingTimeInMillis() / 1000);
};

Kernel.prototype.constructor = Kernel;
module.exports = Kernel;