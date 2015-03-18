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

var PLUGIN_NAME = 'gulp-nightwatch-headless';

var nightwatchBinary = [ "node_modules/nightwatch/bin/nightwatch", path.join( __dirname, "node_modules/nightwatch/bin/nightwatch" ) ];
var defaultSeleniumPath = [ "node_modules/selenium-server/lib/runner/selenium-server-standalone-2.45.0.jar", path.join( __dirname, "node_modules/selenium-server/lib/runner/selenium-server-standalone-2.45.0.jar" ) ];
var phantomJsBinary = [ "node_modules/phantomjs/bin/phantomjs", path.join( __dirname, "node_modules/phantomjs/bin/phantomjs" ) ];
var tempNightwatchDir = "temp";

// NOTE: These may change in future versions of selenium & phantom
var seleniumStartedRegex = new RegExp( "INFO\\:osjs\\.AbstractConnector\\:Started\\s+SocketConnector" );
var phantomStartedRegex = new RegExp( "HUB\\s+Register\\s+\\-\\s+register\\s+\\-\\s+Registered\\s+with\\s+grid\\s+hub(.*?)\\s+\\(ok\\)" );


var testAutomation = function( options ) {
	var options = options || {};

	var subProcesses = [];

	var seleniumPort = 0;
	var httpServerPort = 0;

	var totalOutput = '';
	var httpServerInstance = null;

	var pickExisting = function( arr ) {
		for ( var i=0; i<arr.length; ++i ) {
			if ( fs.existsSync( arr[i] ) ) {
				return arr[i];
			}
		}
		return null;
	};

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
		
		if ( options.verbose ) {
			proc.stderr.pipe( process.stderr );
			proc.stdout.pipe( process.stdout );
		}
		
		var timeoutMillisecs = options.spawnTimeout || 60000;
		timeoutId = setTimeout( timedOut, timeoutMillisecs );
		subProcesses.push( proc );
		return proc;
	};


	var startSelenium = function( callback ) {
		if ( options.selenium && options.selenium.disable ) {
			callback();
		} else {
			async.waterfall( [
					function( asyncCallback ) {
						if ( options.selenium && isFinite( options.selenium.port ) ) {
							asyncCallback( null, options.selenium.port );
						} else {
							freeport( asyncCallback );
						}
					},
					function( port, asyncCallback ) {
						seleniumPort = port;
						// Note: Couldn't use the selenium launcher directly as i can't shut the process down later
						var seleniumPath = ( options.selenium && options.selenium.path ) ? options.selenium.path : pickExisting( defaultSeleniumPath );
						var args = [ '-jar', seleniumPath, '-role', 'hub', '-port', seleniumPort ];
						gutil.log('Starting Selenium standalone server... [port ' + port + ']');
						spawnWithTimeout( 'java', args, ( options.selenium && options.selenium.args ) ? options.selenium.args : null, seleniumStartedRegex, asyncCallback );
					}
				],
				callback );
		}
	};


	var startPhantomJs = function( callback ) {
		if ( options.phantom && options.phantom.disable ) {
			callback();
		} else {
			async.waterfall( [
					function( asyncCallback ) {
						if ( options.phantom && isFinite( options.phantom.port ) ) {
							asyncCallback( null, options.phantom.port );
						} else {
							freeport( asyncCallback );
						}
					},
					function( port, asyncCallback ) {
						var phantomPath = ( options.phantom && options.phantom.path ) ? options.phantom.path : pickExisting( phantomJsBinary );
						var args = [ phantomPath, /*'--debug=true',*/ '--webdriver=' + port, '--webdriver-selenium-grid-hub=http://127.0.0.1:' + seleniumPort ];
						gutil.log('Starting PhantomJS webdriver... [port ' + port + ']');
						spawnWithTimeout( 'node', args, ( options.phantom && options.phantom.args ) ? options.phantom.args : null, phantomStartedRegex, asyncCallback );
					}
				],
				callback );	
		}
	};


	var startHttpServer = function( callback ) {
		if ( options.httpserver && options.httpserver.disable ) {
			callback();
		} else {
			async.waterfall( [
					function( asyncCallback ) {
						if ( options.httpserver && isFinite( options.httpserver.port ) ) {
							asyncCallback( null, options.httpserver.port );
						} else {
							freeport( asyncCallback );
						}
					},
					function( port, asyncCallback ) {
						httpServerPort = port;
						gutil.log('Starting HTTP server... [port ' + port + ']');
						var root = ( options.httpserver && options.httpserver.path ) ? options.httpserver.path : './';
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
		var tempDir = ( options.nightwatch && options.nightwatch.tempDir ) ? options.nightwatch.tempDir : tempNightwatchDir;
		fs.mkdirsSync( tempDir );
		var tempConfigFile = path.join( tempDir, "nightwatch_temp.json" );
		var configOption = ( options.nightwatch && options.nightwatch.config ) ? options.nightwatch.config : "nightwatch.json";
		var json;
		if ( typeof configOption === 'string' ) { // file
			json = JSON.parse( fs.readFileSync( configOption ) );
		} else { // or an object
			json = configOption;
		}
		if ( !( options.selenium && options.selenium.disable ) ) {
			json.selenium.port = seleniumPort;
			json.test_settings.default.selenium_port = seleniumPort;
		}
		if ( !( options.httpserver && options.httpserver.disable ) ) {
			json.test_settings.default.launch_url = "http://127.0.0.1:" + httpServerPort;
		}
		fs.writeFileSync( tempConfigFile, JSON.stringify( json, null, '\t' ) );
		return tempConfigFile;
	};


	var startNightwatch = function( callback ) {
		// read in nightwatch.json, replace seleniumPort, write to temp file, pass to nightwatch
		var configFile = prepareNightwatchConfig();
		var nightwatchPath = ( options.nightwatch && options.nightwatch.path ) ? options.nightwatch.path : pickExisting( nightwatchBinary );
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


	var func = function(callback) {
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
				if ( err ) {
					that.emit('error', new gutil.PluginError( PLUGIN_NAME, typeof err === 'object' ? err.message : err ));
				}
				callback();
			} );
	};

	return through.obj(
		function( file, enc, callback) {
			this.push( file );
			callback();
		},
		func
	);
};


module.exports = testAutomation;
