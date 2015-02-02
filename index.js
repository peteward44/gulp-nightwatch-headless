/*jslint node: true */
'use strict';

var through = require('through2')
	, gutil = require('gulp-util')
	, spawn = require('child_process').spawn
	, async = require('async')
	, fs = require('fs-extra')
	, path = require('path')
	, freeport = require('freeport')
	, httpServer = require('node-http-server');

var PLUGIN_NAME = 'nightwatch-headless';

var nightwatchBinary = "node_modules/nightwatch/bin/nightwatch";
var defaultSeleniumPath = "node_modules/selenium-server/lib/runner/selenium-server-standalone-2.44.0.jar";
var phantomJsBinary = "node_modules/phantomjs/bin/phantomjs";
var tempNightwatchDir = "temp";

// NOTE: These may change in future versions of selenium & phantom
var seleniumStartedRegex = new RegExp( "INFO\\:osjs\\.AbstractConnector\\:Started\\s+SocketConnector" );
var phantomStartedRegex = new RegExp( "HUB\\s+Register\\s+\\-\\s+register\\s+\\-\\s+Registered\\s+with\\s+grid\\s+hub(.*?)\\s+\\(ok\\)" );

var subProcesses = [];

var seleniumPort = 0;
var httpServerPort = 0;

var g_options = null;

var totalOutput = '';
var httpServerInstance = null;

// This spawns a process, and scans the stdout & stderr for a regex which indicates it has started successfully, and times out if it
// doesn't see the regex after X time
var spawnWithTimeout = function( command, args, extraArgs, lookForRegex, callback ) {

	var timeoutId = null;
	var proc = null;

	var doCallback = function( err ) {
		if (err) {
			gutil.log( totalOutput );
		}
		clearTimeout( timeoutId );
		proc.stdout.removeListener( 'data', checkStarted );
		proc.stderr.removeListener( 'data', checkStarted );
		timeoutId = null;
		callback( err );
	};
	
	var checkStarted = function( buf ) {
		var str = String( buf );
		totalOutput += str;
		var matches = str.match( lookForRegex );
		if ( matches && matches.length > 0 ) {
			doCallback();
		}
	};
	
	var timedOut = function() {
		doCallback( 'Process timed out' )
	};
	
	var fullArgs;
	if ( extraArgs ) {
		fullArgs = args.concat( extraArgs );
	} else {
		fullArgs = args;
	}
	proc = spawn( command, fullArgs, { stdio: 'pipe' } );
	proc.stdout.on('data', checkStarted);
	proc.stderr.on('data', checkStarted);
	
	if ( g_options.verbose ) {
		proc.stderr.pipe( process.stderr );
		proc.stdout.pipe( process.stdout );
	}
	
	var timeoutMillisecs = g_options.spawnTimeout || 60000;
	timeoutId = setTimeout( timedOut, timeoutMillisecs );
	subProcesses.push( proc );
	return proc;
};


var startSelenium = function( callback ) {
	if ( g_options.selenium && g_options.selenium.disable ) {
		callback();
	} else {
		async.waterfall( [
				function( asyncCallback ) {
					if ( g_options.selenium && isFinite( g_options.selenium.port ) ) {
						asyncCallback( null, g_options.selenium.port );
					} else {
						freeport( asyncCallback );
					}
				},
				function( port, asyncCallback ) {
					seleniumPort = port;
					// Note: Couldn't use the selenium launcher directly as i can't shut the process down later
					var seleniumPath = ( g_options.selenium && g_options.selenium.path ) ? g_options.selenium.path : defaultSeleniumPath;
					var args = [ '-jar', seleniumPath, '-role', 'hub', '-port', seleniumPort ];
					gutil.log('Starting Selenium standalone server... [port ' + port + ']');
					spawnWithTimeout( 'java', args, ( g_options.selenium && g_options.selenium.args ) ? g_options.selenium.args : null, seleniumStartedRegex, asyncCallback );
				}
			],
			callback );
	}
};


var startPhantomJs = function( callback ) {
	if ( g_options.phantom && g_options.phantom.disable ) {
		callback();
	} else {
		async.waterfall( [
				function( asyncCallback ) {
					if ( g_options.phantom && isFinite( g_options.phantom.port ) ) {
						asyncCallback( null, g_options.phantom.port );
					} else {
						freeport( asyncCallback );
					}
				},
				function( port, asyncCallback ) {
					var phantomPath = ( g_options.phantom && g_options.phantom.path ) ? g_options.phantom.path : phantomJsBinary;
					var args = [ phantomPath, /*'--debug=true',*/ '--webdriver=' + port, '--webdriver-selenium-grid-hub=http://127.0.0.1:' + seleniumPort ];
					gutil.log('Starting PhantomJS webdriver... [port ' + port + ']');
					spawnWithTimeout( 'node', args, ( g_options.phantom && g_options.phantom.args ) ? g_options.phantom.args : null, phantomStartedRegex, asyncCallback );
				}
			],
			callback );	
	}
};


var startHttpServer = function( callback ) {
	if ( g_options.httpserver && g_options.httpserver.disable ) {
		callback();
	} else {
		async.waterfall( [
				function( asyncCallback ) {
					if ( g_options.httpserver && isFinite( g_options.httpserver.port ) ) {
						asyncCallback( null, g_options.httpserver.port );
					} else {
						freeport( asyncCallback );
					}
				},
				function( port, asyncCallback ) {
					httpServerPort = port;
					gutil.log('Starting HTTP server... [port ' + port + ']');
					var root = ( g_options.httpserver && g_options.httpserver.path ) ? g_options.httpserver.path : './';
					httpServerInstance = httpServer.deploy( {
							port: port,
							root: root
						} );
					asyncCallback();
				}
			], callback );
	}
};


var prepareNightwatchConfig = function() {
	var tempDir = ( g_options.nightwatch && g_options.nightwatch.tempDir ) ? g_options.nightwatch.tempDir : tempNightwatchDir;
	fs.mkdirsSync( tempDir );
	var tempConfigFile = path.join( tempDir, "nightwatch_temp.json" );
	var configOption = ( g_options.nightwatch && g_options.nightwatch.config ) ? g_options.nightwatch.config : "nightwatch.json";
	var json;
	if ( typeof configOption === 'string' ) { // file
		json = JSON.parse( fs.readFileSync( configOption ) );
	} else { // or an object
		json = configOption;
	}
	if ( !( g_options.selenium && g_options.selenium.disable ) ) {
		json.selenium.port = seleniumPort;
		json.test_settings.default.selenium_port = seleniumPort;
	}
	if ( !( g_options.httpserver && g_options.httpserver.disable ) ) {
		json.test_settings.default.launch_url = "http://127.0.0.1:" + httpServerPort;
	}
	fs.writeFileSync( tempConfigFile, JSON.stringify( json, null, '\t' ) );
	return tempConfigFile;
};


var startNightwatch = function( callback ) {
	// read in nightwatch.json, replace seleniumPort, write to temp file, pass to nightwatch
	var configFile = prepareNightwatchConfig();
	var nightwatchPath = ( g_options.nightwatch && g_options.nightwatch.path ) ? g_options.nightwatch.path : nightwatchBinary;
	var args = [ nightwatchPath, '--env', 'default', '--config', configFile ];
	gutil.log('Starting Nightwatch test runner...');
	var p = spawn( 'node', args );
	p.stderr.pipe( process.stderr );
	p.stdout.pipe( process.stdout );
	p.on( 'close', function() {
		callback();
	} );
};


var shortDelay = function( callback ) {
	setTimeout( callback, 500 );
};


var testAutomation = function( options ) {
	g_options = options || {};

	var func = function(file, enc, callback) {
		var that = this;
		async.waterfall( [
				startSelenium,
				shortDelay,
				startPhantomJs,
				shortDelay,
				startHttpServer,
				shortDelay,
				startNightwatch
			],
			function( err ) {
				// kill selenium, phantomjs processes (SIGINT allows graceful exit)
				subProcesses.forEach( function( proc ) {
					proc.kill( 'SIGINT' );
				} );
				subProcesses.length = 0;
				if ( httpServerInstance ) {
					httpServerInstance.close();
				}
				if ( !err ) {
					that.push( file );
				} else {
					that.emit('error', new gutil.PluginError( PLUGIN_NAME, typeof err === 'object' ? err.message : err ));
				}
				callback();
			} );
	};

	return through.obj(func);
};


module.exports = testAutomation;
