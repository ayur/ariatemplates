/*
 * Copyright 2012 Amadeus s.a.s.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Transport class for XDR requests.
 * @singleton
 */
Aria.classDefinition({
    $classpath : "aria.core.transport.XDR",
    $singleton : true,
    $constructor : function () {
        /**
         * Tells if the transport object is ready or requires an initialization phase
         * @type Boolean
         */
        this.isReady = false;

        /**
         * Flash transport object
         * @type HTMLElement
         * @protected
         */
        this._transport = null;

        /**
         * Element container for Flash transport object
         * @type HTMLElement
         * @protected
         */
        this._transportContainer = null;

        /**
         * List of pending requests to be reissued once the transport is ready
         * @type Array
         * @protected
         */
        this._pending = [];

        /**
         * Map of ongoing xdr requests. Filled by the XDR transport, not the best design but it's needed by
         * handleXdrResponse, a public method accessed by Flash
         * @type Object
         */
        this.xdrRequests = {};

        /**
         * Number of XDR requests.
         * @type Number
         */
        this.nbXdrRequests = 0;
    },
    $destructor : function () {
        if (this._transportContainer) {
            this._transport = null;
            this._transportContainer.parentNode.removeChild(this._transportContainer);
            this._transportContainer = null;
        }
    },
    $statics : {
        // ERROR MESSAGE:
        IO_MISSING_FLASH_PLUGIN : "Flash player 9+ is required to execute Cross Domain Requests (XDR)."
    },
    $prototype : {
        /**
         * Inizialization function.
         * @param {String} reqId Request identifier
         */
        init : function (reqId) {
            // PROFILING // this.$stopMeasure(req.profilingId);

            // Check if Flash plugin is available
            var navigator = Aria.$global.navigator;
            if (navigator.plugins && navigator.plugins.length > 0) {
                var mime = navigator.mimeTypes, type = "application/x-shockwave-flash";
                if (!mime || !mime[type] || !mime[type].enabledPlugin) {
                    return this.$logError(this.IO_MISSING_FLASH_PLUGIN);
                }
            } else if (navigator.appVersion.indexOf("Mac") == -1 && Aria.$frameworkWindow.execScript) {
                try {
                    var ActiveXObject = Aria.$global.ActiveXObject;
                    var obj = new ActiveXObject("ShockwaveFlash.ShockwaveFlash");

                    if (obj.activeXError) {
                        throw "ActiveXError";
                    }
                } catch (er) {
                    return this.$logError(this.IO_MISSING_FLASH_PLUGIN);
                }
            }

            // We're not ready, listen for the ready event to reissue the request
            this._pending.push(reqId);

            if (!this._transport) {
                var swfUri = Aria.rootFolderPath + 'aria/resources/handlers/IO.swf?t=' + new Date().getTime();
                // note that the flash transport does not work with Safari if the following line is present in
                // parameters:
                // '<param name="wmode" value="transparent"/>'
                var obj = [
                        '<object id="xATIOSwf" type="application/x-shockwave-flash" data="',
                        swfUri,
                        '" width="1" height="1">',
                        '<param name="movie" value="' + swfUri + '" />',
                        '<param name="allowScriptAccess" value="always" />',
                        '<param name="FlashVars" value="readyCallback=' + this.$classpath + '.onXdrReady&handler='
                                + this.$classpath + '.handleXdrResponse" />', '</object>'].join("");

                var document = Aria.$frameworkWindow.document;
                var container = document.createElement('div');
                container.style.cssText = "position:fixed;top:-12000px;left:-12000px";
                document.body.appendChild(container);
                container.innerHTML = obj;

                this._transport = document.getElementById("xATIOSwf");
                this._transportContainer = container;
            }
        },

        /**
         * Callback called by flash transport once initialized, causes a reissue of the requests that were queued while
         * the transport was initializing
         */
        onXdrReady : function () {
            this.isReady = true;

            for (var i = this._pending.length; i--;) {
                aria.core.IO.reissue(this._pending.splice(i, 1)[0]);
            }
        },

        /**
         * Perform a request.
         * @param {aria.core.CfgBeans.IOAsyncRequestCfg} request Request object
         * @param {aria.core.CfgBeans.Callback} callback Internal callback description
         * @throws
         */
        request : function (request, callback) {
            this.nbXdrRequests += 1;

            this.xdrRequests[request.id] = {
                callback : callback,
                transaction : request.id
            };

            var args = {
                xdr : true,
                method : request.method,
                data : request.data
            };

            // This might throw an error, propagate it and let the IO know that there was an exception
            this._transport.send(request.url, args, request.id);
        },

        /**
         * Initial response handler for XDR transactions. The Flash transport calls this function and sends the response
         * payload. This method is called twice per request, first with a xdr:start and then with a xdr:success or
         * xdr:fail
         * @param {Object} res The response object sent from the Flash transport.
         */
        handleXdrResponse : function (res) {
            var reqId = res.tId;
            var conf = this.xdrRequests[reqId];

            var xhrObject = this._transport, callback = conf.callback;

            if (res.statusText === "xdr:start") {
                return this._xdrStart(xhrObject, callback);
            } else {
                // Delete the request only if we're not in xdr:start
                delete this.xdrRequests[reqId];
            }

            res.responseText = decodeURI(res.responseText);
            res.reqId = reqId;

            this._handleTransactionResponse(reqId, res, callback);
        },

        /**
         * Raises the global and transaction start events.
         * @protected
         * @param {Object} connection The transaction object.
         */
        _xdrStart : function (connection) {
            if (connection) {
                // raise global custom event -- startEvent
                aria.core.IO.$raiseEvent({
                    name : "startEvent",
                    o : connection
                });

                if (connection.startEvent) {
                    // raise transaction custom event -- startEvent
                    aria.core.IO.$raiseEvent({
                        name : connection.startEvent,
                        o : connection
                    });
                }
            }
        },

        /**
         * Attempts to interpret the flash response and determine whether the transaction was successful, or if an
         * error or exception was encountered.
         * @private
         * @param {Number} reqId Requst identifier
         * @param {Object} connection The connection object (XHR or ActiveX)
         * @param {aria.core.CfgBeans.Callback} callback Callback from aria.core.IO
         */
        _handleTransactionResponse : function (reqId, connection, callback) {
            var success = connection && connection.statusText === "xdr:success";

            if (success) {
                connection.status = 200;
            } else {
                connection.status = 0;
            }

            callback.fn.call(callback.scope, !success, callback.args, connection);
        }
    }
});