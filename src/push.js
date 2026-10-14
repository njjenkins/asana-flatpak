// Web Push for the Asana tabs. Electron has no push service, so the page's
// PushManager.subscribe() always fails and Asana never sends desktop
// notifications. This does what Chrome does instead: it registers with Google's
// push service (GCM) using the site's VAPID key, then keeps a connection to
// Google's MCS server open to receive the encrypted messages.
//
// Only the GCM and MCS pieces of @eneris/push-receiver are used. Its client is
// built around a Firebase project and only decrypts the legacy aesgcm format,
// which doesn't fit browser-style push.
require('@eneris/push-receiver'); // configures protobufjs for the modules below
const { checkIn } = require('@eneris/push-receiver/dist/gcm');
const { MCSProtoTag, Variables } = require('@eneris/push-receiver/dist/constants');
const Parser = require('@eneris/push-receiver/dist/parser').default;
const protos = require('@eneris/push-receiver/dist/protos');
const ece = require('http_ece');
const crypto = require('crypto');
const tls = require('tls');
const { loadState, saveState } = require('./state');

const STATE_FILE = 'push-state.json';
const REGISTER_URL = 'https://android.clients.google.com/c2dm/register3';
const ENDPOINT_PREFIX = 'https://fcm.googleapis.com/fcm/send/';
const MCS_HOST = 'mtalk.google.com';
const MCS_PORT = 5228;
const CHROME_APP = 'org.chromium.linux';
const PLATFORM_LINUX = 3;
const HEARTBEAT_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 1000;
const REGISTER_ATTEMPTS = 5;
const REGISTER_RETRY_MS = 1000;
// Only needs to cover messages the server might resend before it sees our ack.
const MAX_PERSISTENT_IDS = 100;

const chromeVersion = process.versions.chrome;

function checkInConfig(device) {
  return {
    credentials: device ? { gcm: device } : undefined,
    chromePlatform: PLATFORM_LINUX,
    chromeVersion,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

async function postRegister(device, params) {
  const response = await fetch(REGISTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `AidLogin ${device.androidId}:${device.securityToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ app: CHROME_APP, device: device.androidId, ...params }),
  });
  return { ok: response.ok, text: (await response.text()).trim() };
}

function createKeys() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey('base64url'),
    publicKey: ecdh.getPublicKey('base64url'),
    authSecret: crypto.randomBytes(16).toString('base64url'),
  };
}

// Parses "dh=...; p256ecdsa=..." style header values.
function headerParam(header, name) {
  for (const part of (header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function decrypt(subscription, rawData, appData) {
  const privateKey = crypto.createECDH('prime256v1');
  privateKey.setPrivateKey(subscription.privateKey, 'base64url');
  const params = { privateKey, authSecret: subscription.authSecret };
  // Servers still using the pre-RFC 8291 format send the salt and sender key
  // as headers; aes128gcm carries them in the body.
  if (appData.encryption && appData['crypto-key']) {
    Object.assign(params, {
      version: 'aesgcm',
      salt: headerParam(appData.encryption, 'salt'),
      dh: headerParam(appData['crypto-key'], 'dh'),
    });
  } else {
    params.version = 'aes128gcm';
  }
  return ece.decrypt(rawData, params);
}

function publicSubscription(subscription) {
  return {
    endpoint: ENDPOINT_PREFIX + subscription.token,
    applicationServerKey: subscription.applicationServerKey,
    p256dh: subscription.publicKey,
    auth: subscription.authSecret,
  };
}

class PushService {
  #onMessage;
  #state;
  #queue = Promise.resolve();
  #socket = null;
  #parser = null;
  #connecting = false;
  #retryMs = 0;
  #retryTimer = null;
  #heartbeatTimer = null;
  #heartbeatTimeout = null;
  #streamId = 0;
  #lastStreamIdReported = -1;

  // onMessage(origin, data) gets each decrypted message as a Buffer.
  constructor(onMessage) {
    this.#onMessage = onMessage;
    const state = loadState(STATE_FILE);
    this.#state = {
      device: state.device ?? null,
      subscriptions: state.subscriptions ?? {},
      persistentIds: Array.isArray(state.persistentIds) ? state.persistentIds : [],
    };
  }

  start() {
    if (Object.keys(this.#state.subscriptions).length > 0) this.#connect();
  }

  getSubscription(origin) {
    const subscription = this.#state.subscriptions[origin];
    return subscription ? publicSubscription(subscription) : null;
  }

  // Calls are queued so tabs subscribing at the same time share one
  // registration.
  subscribe(origin, applicationServerKey) {
    return this.#enqueue(async () => {
      const existing = this.#state.subscriptions[origin];
      if (existing?.applicationServerKey === applicationServerKey) return publicSubscription(existing);
      if (existing) await this.#unregister(existing);

      const device = await this.#ensureDevice();
      const appId = `wp:${origin}#${crypto.randomUUID()}`;
      const text = await this.#register(device, { 'X-subtype': appId, sender: applicationServerKey });

      const subscription = { applicationServerKey, appId, token: text.slice('token='.length), ...createKeys() };
      this.#state.subscriptions[origin] = subscription;
      this.#save();
      this.#connect();
      return publicSubscription(subscription);
    });
  }

  unsubscribe(origin) {
    return this.#enqueue(async () => {
      const subscription = this.#state.subscriptions[origin];
      if (!subscription) return false;
      delete this.#state.subscriptions[origin];
      this.#save();
      await this.#unregister(subscription);
      return true;
    });
  }

  // A device that just checked in can briefly get PHONE_REGISTRATION_ERROR, so
  // retry a few times like push-receiver does.
  async #register(device, params) {
    for (let attempt = 1; ; attempt++) {
      const { ok, text } = await postRegister(device, params);
      if (ok && text.startsWith('token=')) return text;
      if (attempt >= REGISTER_ATTEMPTS || !text.includes('PHONE_REGISTRATION_ERROR')) {
        throw new Error(`Push registration failed: ${text}`);
      }
      await new Promise((resolve) => setTimeout(resolve, REGISTER_RETRY_MS));
    }
  }

  #enqueue(task) {
    const result = this.#queue.then(task);
    this.#queue = result.catch(() => {});
    return result;
  }

  async #ensureDevice() {
    if (!this.#state.device) {
      const { androidId, securityToken } = await checkIn(checkInConfig(null));
      this.#state.device = { androidId, securityToken };
      this.#save();
    }
    return this.#state.device;
  }

  async #unregister(subscription) {
    try {
      await postRegister(this.#state.device, {
        'X-subtype': subscription.appId,
        sender: subscription.applicationServerKey,
        delete: 'true',
      });
    } catch (err) {
      console.error('Failed to unregister push subscription:', err);
    }
  }

  #save() {
    saveState(this.#state, STATE_FILE);
  }

  async #connect() {
    if (this.#socket || this.#connecting) return;
    this.#connecting = true;
    clearTimeout(this.#retryTimer);
    try {
      // Like Chrome, check in on every connect to keep the device registered.
      await checkIn(checkInConfig(this.#state.device));
    } catch (err) {
      console.error('Push check-in failed:', err);
      this.#connecting = false;
      this.#scheduleRetry();
      return;
    }
    this.#connecting = false;

    this.#streamId = 0;
    this.#lastStreamIdReported = -1;
    const socket = tls.connect({ host: MCS_HOST, port: MCS_PORT, servername: MCS_HOST });
    socket.setKeepAlive(true, 30_000);
    socket.on('error', (err) => console.error('Push connection error:', err.message));
    socket.on('close', () => {
      if (this.#socket === socket) this.#reconnect();
    });
    this.#socket = socket;
    this.#parser = new Parser(socket);
    this.#parser.on('message', (message) => this.#handleMessage(message));
    this.#parser.on('error', (err) => {
      console.error('Push protocol error:', err);
      this.#reconnect();
    });
    this.#sendLogin();
    this.#resetHeartbeat();
  }

  #disconnect() {
    clearTimeout(this.#heartbeatTimer);
    clearTimeout(this.#heartbeatTimeout);
    this.#parser?.destroy();
    this.#parser = null;
    const socket = this.#socket;
    this.#socket = null;
    socket?.destroy();
  }

  #reconnect() {
    this.#disconnect();
    this.#scheduleRetry();
  }

  #scheduleRetry() {
    this.#retryMs = Math.min(MAX_RETRY_MS, this.#retryMs ? this.#retryMs * 2 : 1000);
    clearTimeout(this.#retryTimer);
    this.#retryTimer = setTimeout(() => this.#connect(), this.#retryMs);
  }

  #send(tag, type, payload, prefix = []) {
    const error = type.verify(payload);
    if (error) throw new Error(error);
    const body = type.encodeDelimited(type.create(payload)).finish();
    this.#socket?.write(Buffer.concat([Buffer.from([...prefix, tag]), body]));
  }

  #sendLogin() {
    const { androidId, securityToken } = this.#state.device;
    const hexId = BigInt(androidId).toString(16);
    this.#send(
      MCSProtoTag.kLoginRequestTag,
      protos.mcs_proto.LoginRequest,
      {
        adaptiveHeartbeat: false,
        authService: 2,
        authToken: securityToken,
        id: `chrome-${chromeVersion}`,
        domain: 'mcs.android.com',
        deviceId: `android-${hexId}`,
        networkType: 1,
        resource: androidId,
        user: androidId,
        useRmq2: true,
        setting: [{ name: 'new_vc', value: '1' }],
        clientEvent: [],
        // Acknowledges these messages so the server stops resending them.
        receivedPersistentId: this.#state.persistentIds,
        heartbeatStat: { ip: '', timeout: true, intervalMs: HEARTBEAT_MS },
      },
      [Variables.kMCSVersion],
    );
  }

  #heartbeatPayload() {
    if (this.#lastStreamIdReported === this.#streamId) return {};
    this.#lastStreamIdReported = this.#streamId;
    return { lastStreamIdReceived: this.#streamId };
  }

  // Any traffic proves the connection is alive. If nothing arrives for two
  // intervals, even after our ping, reconnect.
  #resetHeartbeat() {
    clearTimeout(this.#heartbeatTimer);
    clearTimeout(this.#heartbeatTimeout);
    this.#heartbeatTimer = setTimeout(() => {
      this.#send(MCSProtoTag.kHeartbeatPingTag, protos.mcs_proto.HeartbeatPing, this.#heartbeatPayload());
    }, HEARTBEAT_MS);
    this.#heartbeatTimeout = setTimeout(() => this.#reconnect(), HEARTBEAT_MS * 2);
  }

  #handleMessage({ tag, object }) {
    this.#resetHeartbeat();
    switch (tag) {
      case MCSProtoTag.kLoginResponseTag:
        this.#retryMs = 0;
        // The login carried our acks, so the server won't resend these.
        this.#state.persistentIds = [];
        this.#save();
        break;
      case MCSProtoTag.kHeartbeatPingTag:
        this.#send(MCSProtoTag.kHeartbeatAckTag, protos.mcs_proto.HeartbeatAck, {
          ...this.#heartbeatPayload(),
          ...(object.status ? { status: object.status } : {}),
        });
        break;
      case MCSProtoTag.kDataMessageStanzaTag:
        this.#handleDataMessage(object);
        break;
      case MCSProtoTag.kCloseTag:
        this.#reconnect();
        return;
    }
    this.#streamId++;
  }

  #handleDataMessage({ persistentId, appData = [], rawData }) {
    if (persistentId) {
      if (this.#state.persistentIds.includes(persistentId)) return;
      this.#state.persistentIds = [...this.#state.persistentIds, persistentId].slice(-MAX_PERSISTENT_IDS);
      this.#save();
    }
    const data = Object.fromEntries(appData.map(({ key, value }) => [key, value]));
    const entry = Object.entries(this.#state.subscriptions).find(([, s]) => s.appId === data.subtype);
    if (!entry || !rawData) return;
    const [origin, subscription] = entry;
    let payload;
    try {
      payload = decrypt(subscription, rawData, data);
    } catch (err) {
      console.error('Failed to decrypt push message:', err.message);
      return;
    }
    this.#onMessage(origin, payload);
  }
}

module.exports = { PushService };
