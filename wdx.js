/**
 * Elrest - Node RED - Runtime Node
 * 
 * @copyright 2024 Elrest Automations Systeme GMBH
 */

module.exports = function (RED) {

	"use strict";

	const ws = require("ws");
	const uuid = require("uuid");
	const { Subject, BehaviorSubject } = require("rxjs");

	const WDXSchema = require("@wago/wdx-schema");

	const WS_STATUS_ONLINE_COLOR = 'green'; //@todo Wago green not work as format: #6EC800 , rgb(110, 200, 0)
	const WS_STATUS_OFFLINE_COLOR = 'red';
	const WS_STATUS_ERROR_COLOR = 'red';
	const WS_STATUS_CONNECTING_COLOR = 'blue';

	const WS_STATUS_CODES = {
		CONNECTING: 'CONNECTING',
		OPEN: 'OPEN',
		CLOSING: 'CLOSING',
		CLOSED: 'CLOSED'
	};

	const NODE_STATUS = {
		OPEN: {
			fill: WS_STATUS_ONLINE_COLOR,
			shape: "dot",
			text: "Open"
		},
		ERROR: {
			fill: WS_STATUS_ERROR_COLOR,
			shape: "dot",
			text: "Error"
		},
		CLOSED: {
			fill: WS_STATUS_OFFLINE_COLOR,
			shape: "dot",
			text: "Closed"
		},
		CONNECTING: {
			fill: WS_STATUS_CONNECTING_COLOR,
			shape: "dot",
			text: "Connecting"
		},
		CLOSING: {
			fill: WS_STATUS_CONNECTING_COLOR,
			shape: "dot",
			text: "Closing"
		}
	};

	const WS_RECONNECT_TIMEOUT = 1000;

	function EDesignRuntimeWebSocketClient(config) {
		console.log("EDesignRuntimeWebSocketClient");
		RED.nodes.createNode(this, config);

		this.__ws = undefined;
		this.__wsStatus = new BehaviorSubject(WS_STATUS_CODES.CONNECTING);
		this.__wsIncomingMessages = new Subject();
		this.__closing = false;

		const __connect = async () => {

			this.__ws = new ws(config.url);
			this.__ws.setMaxListeners(0);
			this.__ws.uuid = uuid.v4();

			this.__ws.on('open', () => {
				//console.log("EDesignRuntimeWebSocketClient.opened");

				this.__wsStatus.next(WS_STATUS_CODES.OPEN);
				this.emit(
					'opened',
					{
						count: '',
						id: this.__ws.uuid
					}
				);
			});

			this.__ws.on('close', () => {

				//console.log("EDesignRuntimeWebSocketClient.ws.closed", this.__closing);
				this.__wsStatus.next(WS_STATUS_CODES.CLOSED);

				this.emit('closed', { count: '', id: this.__ws.uuid });

				if (!this.__closing) {
					// Node is closing - do not reconnect ws after its disconnection when node shutdown
					clearTimeout(this.tout);
					//console.log("EDesignRuntimeWebSocketClient.ws.reconnect");
					this.tout = setTimeout(
						() => {
							__connect();
						}, WS_RECONNECT_TIMEOUT
					);
				}
			});

			this.__ws.on('error', (err) => {

				console.error("EDesignRuntimeWebSocketClient.error", err);

				this.emit(
					'erro',
					{
						err: err,
						id: this.__ws.uuid
					}
				);

				if (!this.__closing) {
					clearTimeout(this.tout);

					this.tout = setTimeout(
						() => {
							__connect();
						}, WS_RECONNECT_TIMEOUT
					);
				}
			});

			this.__ws.on(
				'message',
				(data, flags) => {
					//console.debug("EDesignRuntimeWebSocketClient.ws.message", data.toString(), flags);
					this.__wsIncomingMessages.next(JSON.parse(data));
				}
			);
		}

		this.on("close", (done) => {
			//console.log("EDesignRuntimeWebSocketClient.close");

			this.__closing = true;
			this.__wsStatus.next(WS_STATUS_CODES.CLOSING);
			this.__ws.close();
			return done();
		});

		__connect();
	}

	EDesignRuntimeWebSocketClient.prototype.wsStatus = function () {
		return this.__wsStatus;
	}

	EDesignRuntimeWebSocketClient.prototype.wsMessages = function () {
		return this.__wsIncomingMessages;
	}

	EDesignRuntimeWebSocketClient.prototype.wsSend = function (data) {
		//console.log("EDesignRuntimeWebSocketClient.send", data);
		this.__ws.send(JSON.stringify(data));
	}

	RED.nodes.registerType("edesign.runtime.web-socket", EDesignRuntimeWebSocketClient);

	/**
	 * Alarms
	 */

	//edesign.runtime.alarm.list
	function EDesignRuntimeAlarmList(config) {

		console.log("EDesignRuntimeAlarmList", config);

		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			console.log("EDesignRuntimeAlarmList.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ListRequest(
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingListResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.list", EDesignRuntimeAlarmList,);

	//edesign.runtime.alarm.list-active
	function EDesignRuntimeAlarmListActive(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			console.log("EDesignRuntimeAlarmList.input", msg, config);

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ListRequest(true);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingListResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.list-active", EDesignRuntimeAlarmListActive,);

	//edesign.runtime.alarm.list-history
	function EDesignRuntimeAlarmListHistory(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ListHistoryRequest(
				msg.alarmId ?? config['alarmId'] ?? "",
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingListHistoryResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmList.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});

	}
	RED.nodes.registerType("edesign.runtime.alarm.list-history", EDesignRuntimeAlarmListHistory,);

	//edesign.runtime.alarm.confirm
	function EDesignRuntimeAlarmConfirm(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ConfirmRequest(
				msg.alarmId ?? config['alarmId'] ?? undefined,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingConfirmResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmConfirm.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.confirm", EDesignRuntimeAlarmConfirm,);

	//edesign.runtime.alarm.confirm-all
	function EDesignRuntimeAlarmConfirmAll(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const request = new WDXSchema.WDX.Schema.Message.Alarm.ConfirmRequest();

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingConfirmResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmConfirmAll.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.confirm-all", EDesignRuntimeAlarmConfirmAll,);

	//edesign.runtime.alarm.changes
	function EDesignRuntimeAlarmChanges(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			if (true === msg.subscribe) {

				console.debug('EDesignRuntimeAlarmChanges.subscribe',);

				if (undefined === this.subscription || true === this.subscription.closed) {

					const request = new WDXSchema.WDX.Schema.Message.Alarm.SubscribeRequest();

					this.subscription = wsClient.wsMessages().subscribe(
						{
							next: (wsMessage) => {
								if ((wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingSubscribeResponse
									&& wsMessage.uuid === request.uuid) || wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingUpdate) {

									console.debug('EDesignRuntimeAlarmChanges.subscription.next', wsMessage);

									msg.topic = wsMessage.topic;

									if (undefined !== wsMessage.error) {
										msg.payload = wsMessage.error;
										this.send([null, msg]);
									} else {
										msg.payload = wsMessage.body;

										this.status(
											{ fill: "green", shape: "ring", text: "Open - Subscribed" },
										);

										this.send([msg, null, null,]);
									}
								}
							},
							error: (subscribtionError) => {
								console.error("EDesignRuntimeAlarmChanges.input.wsMessages.error", subscribtionError);
								msg.payload = subscribtionError;
								this.send([null, msg]);
							},
							complete: () => {
								this.status(NODE_STATUS.OPEN);
								msg.payload = "complete";
								this.send([null, null, msg]);
							},
						}
					);

					wsClient.wsSend(request);
				}

			} else if (undefined !== this.subscription && false === this.subscription.closed) {
				console.debug('EDesignRuntimeAlarmChanges.unsubscribe');

				this.subscription.unsubscribe();
				this.status(NODE_STATUS.OPEN);
				msg.payload = "complete";
				this.send([null, null, msg]);
			}
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.changes", EDesignRuntimeAlarmChanges,);

	//edesign.runtime.alarm.detail
	function EDesignRuntimeAlarmDetail(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const alarmId = msg.alarmId ?? config['alarmId'] ?? undefined;
			if (undefined === alarmId) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Alarm.DetailRequest(
				alarmId,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingDetailResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmDetail.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.detail", EDesignRuntimeAlarmDetail,);

	function EDesignRuntimeAlarmSave(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const alarm = msg.payload ?? config['alarm'] ?? undefined;

			console.error("EDesignRuntimeAlarmSave.input", { msg: msg, config: config });

			if (undefined === alarm) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Alarm.SetRequest(
				alarm,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingSetResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmSave.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmSave.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.save", EDesignRuntimeAlarmSave,);

	//edesign.runtime.alarm.delete
	function EDesignRuntimeAlarmDelete(config) {
		RED.nodes.createNode(this, config);

		this.status(NODE_STATUS.CONNECTING);

		const wsClient = RED.nodes.getNode(config.client);

		wsClient.on('opened', (event) => {
			this.status(Object.assign(NODE_STATUS.OPEN, {
				event: "connect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('erro', (event) => {
			this.status(Object.assign(NODE_STATUS.ERROR, {
				event: "error",
				_session: { type: "websocket", id: event.id }
			}));
		});

		wsClient.on('closed', (event) => {
			this.status(Object.assign(NODE_STATUS.CLOSED, {
				event: "disconnect",
				_session: { type: "websocket", id: event.id }
			}));
		});

		this.on('input', (msg, nodeSend, nodeDone) => {

			const alarmId = msg.alarmId ?? config['alarmId'] ?? undefined;
			if (undefined === alarmId) {
				return;
			}

			const request = new WDXSchema.WDX.Schema.Message.Alarm.DeleteRequest(
				alarmId,
			);

			const subscription = wsClient.wsMessages().subscribe(
				{
					next: (wsMessage) => {
						if (wsMessage.type === WDXSchema.WDX.Schema.Message.Type.AlarmingDeleteResponse
							&& wsMessage.uuid === request.uuid) {

							if (undefined !== wsMessage.error) {
								msg.payload = wsMessage.error;
								this.send([null, msg]);
							} else {
								msg.payload = wsMessage.body;
								this.send(msg);
							}

							subscription.unsubscribe();
						}
					},
					error: (wsError) => {
						console.error("EDesignRuntimeAlarmDelete.input.wsMessages.error", wsError);
						subscription.unsubscribe();
						this.send([null, wsError]);
					}
				}
			);

			wsClient.wsSend(request);
		});

		this.on('close', () => {
			//console.log("EDesignRuntimeAlarmList.close");

			this.status(NODE_STATUS.CLOSED);
		});
	}
	RED.nodes.registerType("edesign.runtime.alarm.delete", EDesignRuntimeAlarmDelete,);
}