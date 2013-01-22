var q = require('q');
var BufferedStream = require('bufferedstream');
var utils = require('./utils');

module.exports = Request;

/**
 * A Request is created for each new request received by the server. It serves
 * as the concurrency primitive for the duration of the request handling process.
 *
 * The `options` may contain any of the following:
 *
 *   - protocol         The protocol being used (i.e. "http:" or "https:")
 *   - protocolVersion  The protocol version
 *   - method           The request method (e.g. "GET" or "POST")
 *   - remoteHost       The IP address of the client
 *   - remotePort       The port number being used on the client machine
 *   - serverName       The host name of the server
 *   - serverPort       The port the server is listening on
 *   - queryString      The query string used in the request
 *   - scriptName       The virtual location of the application on the server
 *   - pathInfo         The path used in the request
 *   - date             The time the request was received as a Date
 *   - headers          An object of HTTP headers and values. Note: All header
 *                      names are lowercased for consistency
 *   - content          A readable stream for the body of the request
 *   - error            A writable stream for error messages
 */
function Request(options) {
  if (!(this instanceof Request)) return new Request(options);
  options = options || {};

  this._protocol = options.protocol || 'http:';
  this.protocolVersion = options.protocolVersion || '1.0';
  this.method = (options.method || 'GET').toUpperCase();
  this._remoteHost = options.remoteHost || '';
  this.remotePort = parseInt(options.remotePort, 10) || 0;
  this.serverName = options.serverName || '';
  this.serverPort = parseInt(options.serverPort, 10) || 0;
  this.queryString = options.queryString || '';
  this.scriptName = options.scriptName || '';
  this.pathInfo = options.pathInfo || '';
  this.date = options.date || new Date;

  // Make sure pathInfo is at least '/'.
  if (this.scriptName === '' && this.pathInfo === '') this.pathInfo = '/';

  this.headers = {};
  if (options.headers) {
    for (var headerName in options.headers) {
      this.headers[headerName.toLowerCase()] = options.headers[headerName];
    }
  }

  // Buffer the input stream up to the maximum buffer size and pause it so
  // we don't miss data listeners that are registered in future ticks.
  this.content = new BufferedStream(Request.maxInputBufferSize, options.content || '');
  this.content.pause();

  if (options.error) {
    if (options.error instanceof Stream) {
      this.error = options.error;
    } else {
      throw new Error('Environment error must be a Stream');
    }
  } else {
    this.error = process.stderr;
  }
}

/**
 * The maximum size of the input buffer for request bodies.
 */
Request.maxInputBufferSize = Math.pow(2, 16);

/**
 * The maximum size of the output buffer for response bodies.
 */
Request.maxOutputBufferSize = Math.pow(2, 16);

/**
 * Creates a mach.Request from the given node server/request objects.
 */
Request.makeFromNodeRequest = makeRequestFromNodeRequest;
function makeRequestFromNodeRequest(nodeServer, nodeRequest) {
  var serverAddress = nodeServer.address();
  var parsedUrl = utils.parseUrl(nodeRequest.url);
  var request = new Request({
    protocolVersion: nodeRequest.httpVersion,
    method: nodeRequest.method,
    remoteHost: nodeRequest.connection.remoteAddress,
    remotePort: nodeRequest.connection.remotePort,
    serverName: serverAddress.address,
    serverPort: serverAddress.port,
    pathInfo: parsedUrl.pathname,
    queryString: parsedUrl.query || '',
    headers: nodeRequest.headers,
    content: nodeRequest
  });

  return request;
}

/**
 * Calls the given `app` with this request as the only argument. Always returns
 * a promise for a response object with three properties: `status`, `headers`,
 * and `content`.
 *
 * Note: The `content` will always be a *paused* readable Stream of data.
 */
Request.prototype.call = function (app) {
  try {
    var value = app(this);
  } catch (error) {
    return q.reject(error);
  }

  return q.when(value, function (response) {
    if (typeof response === 'object') {
      if (Array.isArray(response)) {
        response = {
          status: response[0],
          headers: response[1],
          content: response[2],
        };
      }
    } else if (typeof response === 'string') {
      response = { content: response };
    } else if (typeof response === 'number') {
      response = { status: response };
    }

    if (response.status == null)  response.status = 200;
    if (response.headers == null) response.headers = {};
    if (response.content == null) response.content = '';

    if (typeof response.content === 'string') {
      response.headers['Content-Length'] = Buffer.byteLength(response.content);
      response.content = new BufferedStream(Request.maxOutputBufferSize, response.content);
    }

    response.content.pause();

    return response;
  });
};

/**
 * The protocol used in the request (i.e. "http:" or "https:").
 */
Request.prototype.__defineGetter__('protocol', function () {
  if (this.headers['x-forwarded-ssl'] === 'on') {
    return 'https:';
  }

  if (this.headers['x-forwarded-proto']) {
    return this.headers['x-forwarded-proto'].split(',')[0] + ':';
  }

  return this._protocol;
});

/**
 * True if this request was made over SSL.
 */
Request.prototype.__defineGetter__('isSsl', function () {
  return this.protocol === 'https:';
});

/**
 * True if this request was made using XMLHttpRequest.
 */
Request.prototype.__defineGetter__('isXhr', function () {
  return this.headers['x-requested-with'] === 'XMLHttpRequest';
});

/**
 * The IP address of the client.
 */
Request.prototype.__defineGetter__('remoteHost', function () {
  return this.headers['x-forwarded-for'] || this._remoteHost;
});

Request.prototype.__defineGetter__('hostWithPort', function () {
  var forwarded = this.headers['x-forwarded-host'];

  if (forwarded) {
    var parts = forwarded.split(/,\s?/);
    return parts[parts.length - 1];
  }

  if (this.headers.host) {
    return this.headers.host;
  }

  if (this.serverPort) {
    return this.serverName + ':' + this.serverPort;
  }

  return this.serverName;
});

/**
 * Returns the name of the host used in this request.
 */
Request.prototype.__defineGetter__('host', function () {
  return this.hostWithPort.replace(/:\d+$/, '');
});

/**
 * Returns the port number used in this request.
 */
Request.prototype.__defineGetter__('port', function () {
  var port = this.hostWithPort.split(':')[1] || this.headers['x-forwarded-port'];
  if (port) return parseInt(port, 10);
  if (this.isSsl) return 443;
  if (this.headers['x-forwarded-host']) return 80;
  return this.serverPort;
});

/**
 * Returns a URL containing the protocol, hostname, and port of the original
 * request.
 */
Request.prototype.__defineGetter__('baseUrl', function () {
  var protocol = this.protocol;
  var base = protocol + '//' + this.host;
  var port = this.port;

  if ((protocol === 'https:' && port !== 443) || (protocol === 'http:' && port !== 80)) {
    base += ':' + port;
  }

  return base;
});

/**
 * The path of this request, without the query string.
 */
Request.prototype.__defineGetter__('path', function () {
  return this.scriptName + this.pathInfo;
});

/**
 * The path of this request, including the query string.
 */
Request.prototype.__defineGetter__('fullPath', function () {
  return this.path + (this.queryString ? '?' + this.queryString : '');
});

/**
 * The original URL of this request.
 */
Request.prototype.__defineGetter__('url', function () {
  return this.baseUrl + this.fullPath;
});

/**
 * An object containing the properties and values that were URL-encoded in
 * the query string.
 */
Request.prototype.__defineGetter__('query', function () {
  if (!this._query) {
    this._query = utils.parseQueryString(this.queryString);
  }

  return this._query;
});