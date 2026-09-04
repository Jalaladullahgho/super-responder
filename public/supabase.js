(function () {
  "use strict";

  class RealtimeChannel {
    constructor(client, name) {
      this.client = client;
      this.name = name;
      this.topic = `realtime:${name}`;
      this.socket = null;
      this.handler = null;
      this.options = null;
      this.statusHandler = null;
      this.ref = 0;
      this.joinRef = null;
      this.heartbeatTimer = null;
      this.connectTimer = null;
      this.closedByUser = false;
    }

    on(event, options, callback) {
      if (event !== "postgres_changes") return this;
      this.options = options || {};
      this.handler = callback;
      return this;
    }

    subscribe(callback) {
      this.statusHandler = typeof callback === "function" ? callback : function () {};
      this.closedByUser = false;
      this.connect();
      return this;
    }

    connect() {
      if (this.closedByUser || !this.client) return;
      if (this.socket) {
        try { this.socket.close(); } catch (_) {}
      }
      const url = `${this.client.url}/realtime/v1/websocket?apikey=${encodeURIComponent(this.client.key)}&vsn=1.0.0`;
      this.socket = new WebSocket(url);

      this.socket.onopen = () => {
        const joinRef = String(++this.ref);
        this.joinRef = joinRef;
        const payload = {
          config: {
            broadcast: { ack: false, self: false },
            presence: { enabled: false },
            postgres_changes: this.options ? [this.options] : [],
            private: false
          }
        };
        this.socket.send(JSON.stringify({
          topic: this.topic,
          event: "phx_join",
          payload,
          ref: joinRef,
          join_ref: joinRef
        }));
        this.startHeartbeat();
      };

      this.socket.onmessage = (event) => {
        let message;
        try { message = JSON.parse(event.data); } catch (_) { return; }
        if (message.topic !== this.topic) return;

        if (message.event === "phx_reply") {
          const response = message.payload || {};
          if (message.ref === this.joinRef) {
            if (response.status === "ok") this.statusHandler("SUBSCRIBED");
            else this.statusHandler("CHANNEL_ERROR");
          }
          return;
        }

        if (message.event === "postgres_changes") {
          const data = message.payload?.data;
          if (!data || !this.handler) return;
          this.handler({
            eventType: data.type,
            schema: data.schema,
            table: data.table,
            commit_timestamp: data.commit_timestamp,
            new: data.record || {},
            old: data.old_record || {},
            errors: data.errors || null
          });
        }
      };

      this.socket.onerror = () => {
        if (!this.closedByUser) this.statusHandler("CHANNEL_ERROR");
      };

      this.socket.onclose = () => {
        this.stopHeartbeat();
        if (!this.closedByUser) this.statusHandler("CLOSED");
      };
    }

    push(event, payload, joinRef) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const ref = String(++this.ref);
      this.socket.send(JSON.stringify({
        topic: this.topic,
        event,
        payload,
        ref,
        join_ref: joinRef || this.joinRef || ref
      }));
    }

    startHeartbeat() {
      this.stopHeartbeat();
      this.heartbeatTimer = setInterval(() => {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
          this.push("heartbeat", {}, null);
        }
      }, 25000);
    }

    stopHeartbeat() {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    close() {
      this.closedByUser = true;
      this.stopHeartbeat();
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      if (this.socket) {
        try { this.socket.close(); } catch (_) {}
      }
      this.socket = null;
    }
  }

  class SupabaseClient {
    constructor(url, key) {
      this.url = String(url).replace(/\/$/, "");
      this.key = key;
      this.channels = new Set();
    }

    channel(name) {
      const channel = new RealtimeChannel(this, name);
      this.channels.add(channel);
      return channel;
    }

    removeChannel(channel) {
      if (channel) channel.close();
      this.channels.delete(channel);
    }
  }

  window.supabase = {
    createClient: function (url, key) {
      return new SupabaseClient(url, key);
    }
  };
})();