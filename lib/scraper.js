var Promise = require('bluebird');

var fs = require('fs-extra');
var existsAsync = Promise.promisify(fs.stat);
var outputFileAsync = Promise.promisify(fs.outputFile);
var ensureDirAsync = Promise.promisify(fs.ensureDir);

var path = require('path');
var _ = require('lodash');

var defaults = require('./config/defaults');
var recursiveSources = require('./config/recursive-sources');
var Resource = require('./resource');

var getFilenameGenerator = require('./filename-generators/filename-generator-getter');
var makeRequest = require('./request');
var compareUrls = require('compare-urls');

var loadHtml = require('./file-handlers/html');
var loadCss = require('./file-handlers/css');
function loadHtmlAndCss (context, po) {
	return loadHtml(context, po).then(function loadCssFromHtml (loaded) {
		return loadCss(context, loaded);
	});
}

function Scraper (options) {
	this.originalResources = [];
	this.loadedResources = [];

	this.options = _.extend({}, defaults, options);
	this.options.request = _.extend({}, defaults.request, options.request);
	this.options.directory = path.resolve(process.cwd(), this.options.directory || '');
	this.options.filenameGenerator = getFilenameGenerator(this.options.filenameGenerator);
}

Scraper.prototype.getLoadedResource = function getLoadedResource (resource) {
	return _.find(this.loadedResources, function checkUrlsEqual (lr) {
		return compareUrls(resource.getUrl(), lr.getUrl());
	});
};

Scraper.prototype.addLoadedResource = function addLoadedResource (resource) {
	this.loadedResources.push(resource);
};

Scraper.prototype.getHtmlSources = function getHtmlSources () {
	return this.options.sources;
};

Scraper.prototype.getResourceHandler = function getHandler (resource) {
	var self = this;
	var depth = resource.getDepth();
	var depthGreaterThanMax = self.options.maxDepth && depth >= self.options.maxDepth;

	switch (true) {
		case depthGreaterThanMax: return _.noop;
		case resource.isCss(): return loadCss;
		case resource.isHtml(): return loadHtmlAndCss;
		default: return _.noop;
	}
};

Scraper.prototype.loadResource = function loadResource (resource) {
	var self = this;

	if(!self.options.urlFilter(resource.url)){
		return Promise.resolve(null);
	}

	// try to find already loaded
	var loaded = self.getLoadedResource(resource);

	if (!loaded) {
		var url = resource.getUrl();
		var filename = self.options.filenameGenerator(resource, self.options, self.loadedResources);
		resource.setFilename(filename);

		self.addLoadedResource(resource);

		// Request -> processing -> save to fs
		return self.makeRequest(url).then(function requestCompleted (data) {
			resource.setUrl(data.url);  // Url may be changed in redirects
			resource.setText(data.body);
			var handleFile = self.getResourceHandler(resource);
			return handleFile(self, resource);
		}).then(function fileHandled () {
			var filename = path.join(self.options.directory, resource.getFilename());
			var text = resource.getText();
			return outputFileAsync(filename, text, { encoding: 'binary' });
		}).then(function fileSaved () {
			return Promise.resolve(resource);
		});
	}
	return Promise.resolve(loaded);
};

Scraper.prototype.validate = function validate () {
	var dir = this.options.directory;
	return existsAsync(dir).then(function handleDirectoryExist () {
		return Promise.reject(new Error('Path ' + dir + ' exists'));
	}, function handleDirectoryNotExist () {
		return Promise.resolve();
	});
};

Scraper.prototype.prepare = function prepare () {
	var self = this;

	// Create makeRequest function with custom request params
	self.makeRequest = makeRequest.bind(null, self.options.request);

	// Create array of Resource for downloading
	self.options.urls = _.isArray(self.options.urls) ? self.options.urls : [self.options.urls];
	self.originalResources = _.map(self.options.urls, function createResource (obj) {
		var url = _.isObject(obj) && _.has(obj, 'url') ? obj.url : obj;
		var filename = _.isObject(obj) && _.has(obj, 'filename') ? obj.filename : self.options.defaultFilename;
		return new Resource(url, filename);
	});

	if (self.options.recursive) {
		self.options.sources = _.union(self.options.sources, recursiveSources);
	}

	return ensureDirAsync(self.options.directory);
};

Scraper.prototype.load = function load () {
	var self = this;
	return Promise.map(self.originalResources, function loadResource (resource) {
		return self.loadResource(resource);
	});
};

Scraper.prototype.errorCleanup = function errorCleanup (error) {
	if (!_.isEmpty(this.loadedResources)) {
		fs.removeSync(this.options.directory);
	}
	throw error;
};

Scraper.prototype.scrape = function scrape (callback) {
	var self = this;
	return Promise.bind(self)
		.then(self.validate)
		.then(self.prepare)
		.then(self.load)
		.catch(self.errorCleanup)
		.asCallback(callback);
};

module.exports = Scraper;
