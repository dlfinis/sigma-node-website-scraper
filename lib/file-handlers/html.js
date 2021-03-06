var cheerio = require('cheerio');
var Promise = require('bluebird');
var srcset = require('srcset');
var utils = require('../utils');

function loadHtml (context, resource) {
	var rules = context.getHtmlSources();
	var p = beforeHandle(resource);

	rules.forEach(function loadForRule (rule) {
		p = p.then(function loadResources () {
			return loadResourcesForRule(context, resource, rule);
		});
	});
	return p;
}

function loadTextToCheerio (text) {
	return cheerio.load(text, {
		decodeEntities: false
	});
}

function loadModalHTML(callback){
	var readFile = Promise.promisify(require("fs").readFile);
	return readFile(__dirname +'/modal-redirect.html','utf8');
}

function beforeHandle (resource,urls) {
	var text = resource.getText();
	var $ = loadTextToCheerio(text);

	$('a').each(function(i, elem) {
  	var el = $(this);
  	if(el.attr('href')){
  		var newUrl = utils.getUrl(resource.getUrl(), el.attr('href'));
  		el.attr('href',newUrl);
  		el.attr('onclick','xredirect(this,event);');
  	}
	});

	$('base').each(function handleBaseTag () {
		var el = $(this);
		console.log(el.attr());
		var href = el.attr('href');
		if (href) {
			var newUrl = utils.getUrl(resource.getUrl(), href);
			resource.setUrl(newUrl);
			el.remove();
		}
	});

	return loadModalHTML()
		.then(function (data)
		{
			$('body').append(data);
		})
		.catch(function (err) {
			$('a').each(function(i, elem) {
		  	var el = $(this);
			if(el.attr('href'))	el.attr('onclick','return false;');
			});
		})
		.then(function () {
			text = $.html();
			resource.setText(text);
			return Promise.resolve(resource);
		});
}

/**
 * @param {HtmlData} htmlData
 * @returns {Function} - function which loads resources with given html data
 */
function getResourceLoaderByHtmlData (htmlData) {
	if (htmlData.tagName === 'img' && htmlData.attributeName === 'srcset') {
		return loadImgSrcsetResource;
	}
	return loadGeneralResource;
}

/**
 * @param {Object} el - cheerio element
 * @param {string} attrName - attribute name
 * @returns {HtmlData}
 */
function createHtmlData (el, attrName) {
	return {
		tagName: el[0].name,
		attributeName: attrName,
		attributeValue: el.attr(attrName)
	};
}

/**
 * Download resources from <img srcset="...">
 * @param context
 * @param {Resource} parentResource
 * @param {HtmlData} childResourceHtmlData
 * @returns {Promise}
 */
function loadImgSrcsetResource (context, parentResource, childResourceHtmlData) {
	var imgScrsetParts = srcset.parse(childResourceHtmlData.attributeValue);

	return Promise.mapSeries(imgScrsetParts, function loadImgSrcsetPart (imgScrsetPart) {
		var childResourceUrl = utils.getUrl(parentResource.getUrl(), imgScrsetPart.url);
		var childResource = parentResource.createChild(childResourceUrl);
		childResource.setHtmlData(childResourceHtmlData);

		return context.loadResource(childResource).then(function updateSrcsetPart (loadedResource) {
			if(loadedResource){
				parentResource.updateChild(childResource, loadedResource);
				imgScrsetPart.url = loadedResource.getFilename();
			}
		});
	}).then(function updateSrcset () {
		return Promise.resolve(srcset.stringify(imgScrsetParts));
	});
}

/**
 * Download common resource
 * @param context
 * @param {Resource} parentResource
 * @param {HtmlData} childResourceHtmlData
 * @returns {Promise}
 */
function loadGeneralResource (context, parentResource, childResourceHtmlData) {
	var attr = childResourceHtmlData.attributeValue;

	var resourceUrl = utils.getUrl(parentResource.getUrl(), attr);
	var htmlResource = parentResource.createChild(resourceUrl);
	htmlResource.setHtmlData(childResourceHtmlData);

	return context.loadResource(htmlResource).then(function handleLoadedSource (loadedResource) {
		if(!loadedResource){
			return attr;
		}
		parentResource.updateChild(htmlResource, loadedResource);

		var relativePath = utils.getRelativePath(parentResource.getFilename(), loadedResource.getFilename());
		if(context.options.prettifyUrls){
			relativePath = relativePath.replace(context.options.defaultFilename, '');
		}
		var hash = utils.getHashFromUrl(attr);

		if (hash && loadedResource.isHtml()) {
			relativePath = relativePath.concat(hash);
		}

		return relativePath;
	});
}

function loadResourcesForRule (context, resource, rule) {
	var text = resource.getText();
	var $ = loadTextToCheerio(text);

	var promises = $(rule.selector).map(function loadForElement () {
		var el = $(this);
		if (el.attr(rule.attr)) {
			var childResourceHtmlData = createHtmlData(el, rule.attr);
			var loadResourcesForElement = getResourceLoaderByHtmlData(childResourceHtmlData);

			return loadResourcesForElement(context, resource, childResourceHtmlData).then(function changeAttr (updatedAttr) {
				el.attr(rule.attr, updatedAttr);
			});
		}
		return Promise.resolve();
	}).get();

	return utils.waitAllFulfilled(promises).then(function updateHtmlText () {
		text = $.html();
		resource.setText(text);
		return resource;
	});
}

module.exports = loadHtml;
