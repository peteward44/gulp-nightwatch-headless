# Deprecated

Karma (karma-runner/karma) is a much sleeker alternative to this now, this project won't be updated

# gulp-nightwatch-headless
An almost-zero configuration Gulp plugin to run Selenium, PhantomJS, Nightwatch and a HTTP server together in one process.

```
npm install gulp-nightwatch-headless --save-dev
```

For anyone who wants to run Selenium, PhantomJS and a HTTP server for tests without the hassle of setting up a dedicated server for them.

Plugin accepts a config object. All options have defaults, all ports that the processes run on will be selected randomly (assuming it's open) but can be overriden with the 'port' option.

Example usage

```
var nightwatchHeadless = require( 'gulp-nightwatch-headless' );

gulp.task( 'automated-tests', function() {
	return gulp.src('')
		.pipe(nightwatchHeadless({
			nightwatch: {
				tempDir: 'temp',
				config: 'nightwatch.json'
			},
			selenium: {
			//	disable: true
			},
			httpserver: {
				port: 2043,
				path: 'output'
			},
			verbose: true
		}))
		.on('error', gutil.log);
} );

```

