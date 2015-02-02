# gulp-nightwatch-headless
An almost-zero configuration Gulp plugin to run Selenium, PhantomJS, Nightwatch and a HTTP server together in one process.

For anyone who wants to run Selenium, PhantomJS and a HTTP server for tests without the hassle of setting up a dedicated server for them.

Plugin accepts a config object. All options have defaults, all ports that the processes run on will be selected randomly (assuming it's open) but can be overriden with the 'port' option.

Example usage

```
var nightwatchHeadless = require( 'gulp-nightwatch-headless' );

function task() {
	return gulp.src('')
		.pipe(nightwatchHeadless({
			nightwatch: {
				tempDir: 'temp',
				config: 'nightwatch.json'
			},
			selenium: {
		//	  disable: true
			},
			httpserver: {
			  port: 2043,
				path: 'output'
			},
	    verbose: true
		}))
		.on('error', gutil.log);
}

```

