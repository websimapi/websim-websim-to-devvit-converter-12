export const websimToDevvitPolyfill = `
(function() {
  console.log('[Devvit Bridge] Initializing WebSim compatibility layer...');

  const CALL_TIMEOUT = 10000;
  const pendingRequests = new Map();

  // 1. Communication Bridge
  function callDevvit(type, data) {
    return new Promise((resolve, reject) => {
      const messageId = Math.random().toString(36).substring(7);
      const timer = setTimeout(() => {
        pendingRequests.delete(messageId);
        reject(new Error('Timeout waiting for Devvit response: ' + type));
      }, CALL_TIMEOUT);

      pendingRequests.set(messageId, { resolve, reject, timer });

      window.parent.postMessage({
        type: type,
        data: data,
        messageId: messageId
      }, '*');
    });
  }

  window.addEventListener('message', (event) => {
    if (!event.data) return;

    // Handle Response
    if (event.data.type === 'devvit-response') {
      const { messageId, result, error } = event.data.data;
      if (pendingRequests.has(messageId)) {
        const { resolve, reject, timer } = pendingRequests.get(messageId);
        clearTimeout(timer);
        pendingRequests.delete(messageId);
        if (error) reject(new Error(error));
        else resolve(result);
      }
    }
    
    // Handle Realtime Events
    if (event.data.type === 'devvit-realtime') {
       const msg = event.data.data.message;
       // Dispatch to room
       if (window.room && window.room._handleRealtime) {
         window.room._handleRealtime(msg);
       }
    }
  });

  // 2. Mock Classes
  
  // Helpers
  window.getUserAvatar = async (username) => {
     try {
       const res = await callDevvit('user:getAvatar', { username });
       return res.success ? res.data : null;
     } catch(e) { return null; }
  };

  // Cache current user
  let _currentUser = { id: 'anon', username: 'Guest' };
  const _initUser = callDevvit('user:getCurrent', {}).then(r => {
      if(r.success) _currentUser = r.data;
      return _currentUser;
  }).catch(e => console.error('Failed to get user', e));

  window.websim = {
    getCurrentUser: () => _initUser,
    upload: async (blob) => URL.createObjectURL(blob) // Fallback
  };

  class WebsimRoom {
    constructor() {
      this.peers = {};
      this.state = {};
      this._presenceSubs = [];
      this._stateSubs = [];
      this._msgSubs = [];
      
      // Auto-join main channel
      callDevvit('realtime:join', { channelName: 'post:main' }).catch(console.error);
    }

    // Database / Collections
    collection(name) {
      const key = 'collection:' + name;
      return {
        create: async (data) => {
          const id = Math.random().toString(36).substr(2, 9);
          const doc = { id, ...data, created_at: new Date().toISOString(), owner: _currentUser };
          await callDevvit('db:hSet', { 
            key: key,
            fields: { [id]: JSON.stringify(doc) }
          });
          return doc;
        },
        update: async (id, data) => {
            // Need to fetch first to merge? Simplified: just merge on top
            // In a real app we might need atomic ops, but here we just overwrite fields
            const currentStr = (await callDevvit('db:get', { key: key }))?.data?.[id]; 
            const current = currentStr ? JSON.parse(currentStr) : {};
            const doc = { ...current, ...data, id };
            await callDevvit('db:hSet', { key: key, fields: { [id]: JSON.stringify(doc) } });
            return doc;
        },
        delete: async (id) => {
            await callDevvit('db:hDel', { key: key, fields: [id] });
        },
        getList: async () => {
          const res = await callDevvit('db:hGetAll', { key: key });
          if (!res.success) return [];
          return Object.values(res.data || {}).map(s => {
              try { return JSON.parse(s); } catch(e) { return null; }
          }).filter(Boolean).sort((a,b) => new Date(b.created_at) - new Date(a.created_at));
        },
        subscribe: (cb) => {
           // Emulate subscription via polling (Realtime db streams are complex)
           let active = true;
           const poll = async () => {
             if (!active) return;
             const list = await this.collection(name).getList();
             cb(list);
             setTimeout(poll, 2000);
           };
           poll();
           return () => { active = false; };
        }
      };
    }

    // Realtime Presence & State
    async updatePresence(data) {
       await callDevvit('realtime:updatePresence', { 
         channelName: 'post:main',
         presence: data 
       });
    }

    async updateRoomState(data) {
       await callDevvit('realtime:updateRoomState', {
         channelName: 'post:main',
         state: data
       });
    }

    subscribePresence(cb) { this._presenceSubs.push(cb); }
    subscribeRoomState(cb) { this._stateSubs.push(cb); }
    
    send(msg) {
      callDevvit('realtime:send', { 
          channelName: 'post:main', 
          message: { type: 'broadcast', payload: msg, sender: _currentUser } 
      });
    }

    // Internal handler for incoming realtime msgs from Devvit
    _handleRealtime(msg) {
       if (msg.type === 'presence_update') {
          this.peers[msg.userId] = { ...this.peers[msg.userId], ...msg.presence, id: msg.userId };
          // Fetch avatar if missing
          if (!this.peers[msg.userId].avatarUrl) {
              window.getUserAvatar(this.peers[msg.userId].username || 'Guest')
                .then(url => this.peers[msg.userId].avatarUrl = url);
          }
          this._presenceSubs.forEach(cb => cb(this.peers));
       }
       else if (msg.type === 'roomstate_update') {
          this.state = { ...this.state, ...msg.state };
          this._stateSubs.forEach(cb => cb(this.state));
       }
       else if (msg.type === 'broadcast') {
          // General message handling if needed
       }
    }
  }

  // Expose
  window.WebsimSocket = WebsimRoom;
  window.room = new WebsimRoom();
  window.party = window.room; // Alias for PartyKit style

  console.log('[Devvit Bridge] WebSim compatibility layer ready!');
})();
`;

export const getDevvitBridgeServerCode = () => `// src/devvit-bridge.ts
// Server-side bridge for WebSim → Devvit API translation

import type { Context } from '@devvit/public-api';

export class DevvitBridge {
  private context: Context;
  private messageHandlers: Map<string, Function> = new Map();
  
  constructor(context: Context) {
    this.context = context;
    this.setupHandlers();
  }

  private setupHandlers() {
    // Database Operations -> Redis
    this.messageHandlers.set('db:hGetAll', this.handleRedisHGetAll.bind(this));
    this.messageHandlers.set('db:hSet', this.handleRedisHSet.bind(this));
    this.messageHandlers.set('db:hDel', this.handleRedisHDel.bind(this));
    this.messageHandlers.set('db:get', this.handleRedisGet.bind(this));
    this.messageHandlers.set('db:set', this.handleRedisSet.bind(this));
    this.messageHandlers.set('db:del', this.handleRedisDel.bind(this));
    
    // Realtime -> Reddit Realtime
    this.messageHandlers.set('realtime:join', this.handleRealtimeJoin.bind(this));
    this.messageHandlers.set('realtime:send', this.handleRealtimeSend.bind(this));
    this.messageHandlers.set('realtime:updatePresence', this.handleUpdatePresence.bind(this));
    this.messageHandlers.set('realtime:updateRoomState', this.handleUpdateRoomState.bind(this));
    
    // User Identity -> Reddit User API
    this.messageHandlers.set('user:getInfo', this.handleGetUserInfo.bind(this));
    this.messageHandlers.set('user:getAvatar', this.handleGetAvatar.bind(this));
    this.messageHandlers.set('user:getCurrent', this.handleGetCurrentUser.bind(this));
  }

  async handleMessage(type: string, data: any): Promise<any> {
    const handler = this.messageHandlers.get(type);
    if (!handler) {
      throw new Error(\`Unknown message type: \${type}\`);
    }
    return await handler(data);
  }

  // REDIS HANDLERS
  
  private async handleRedisHGetAll(data: { key: string }) {
    try {
      const result = await this.context.redis.hGetAll(data.key);
      return { success: true, data: result || {} };
    } catch (error: any) {
      console.error('[Redis] hGetAll error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleRedisHSet(data: { key: string, fields: Record<string, string> }) {
    try {
      await this.context.redis.hSet(data.key, data.fields);
      return { success: true };
    } catch (error: any) {
      console.error('[Redis] hSet error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleRedisHDel(data: { key: string, fields: string[] }) {
    try {
      await this.context.redis.hDel(data.key, data.fields);
      return { success: true };
    } catch (error: any) {
      console.error('[Redis] hDel error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleRedisGet(data: { key: string }) {
    try {
      const result = await this.context.redis.get(data.key);
      return { success: true, data: result };
    } catch (error: any) {
      console.error('[Redis] get error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleRedisSet(data: { key: string, value: string }) {
    try {
      await this.context.redis.set(data.key, data.value);
      return { success: true };
    } catch (error: any) {
      console.error('[Redis] set error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleRedisDel(data: { keys: string[] }) {
    try {
      await this.context.redis.del(data.keys);
      return { success: true };
    } catch (error: any) {
      console.error('[Redis] del error:', error);
      return { success: false, error: error.message };
    }
  }

  // REALTIME HANDLERS
  
  private async handleRealtimeJoin(data: { channelName: string }) {
    try {
      const channel = this.context.realtime.channel(data.channelName);
      await channel.subscribe();
      return { success: true, channelId: data.channelName };
    } catch (error: any) {
      console.error('[Realtime] join error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleRealtimeSend(data: { channelName: string, message: any }) {
    try {
      const channel = this.context.realtime.channel(data.channelName);
      await channel.send(data.message);
      return { success: true };
    } catch (error: any) {
      console.error('[Realtime] send error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleUpdatePresence(data: { channelName: string, presence: any }) {
    try {
      const channel = this.context.realtime.channel(data.channelName);
      const userId = this.context.userId || 'anonymous';
      const presenceKey = \`presence:\${data.channelName}:\${userId}\`;
      
      await this.context.redis.set(presenceKey, JSON.stringify(data.presence));
      await this.context.redis.expire(presenceKey, 30);
      
      await channel.send({
        type: 'presence_update',
        userId,
        presence: data.presence
      });
      
      return { success: true };
    } catch (error: any) {
      console.error('[Realtime] updatePresence error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleUpdateRoomState(data: { channelName: string, state: any }) {
    try {
      const channel = this.context.realtime.channel(data.channelName);
      const stateKey = \`roomstate:\${data.channelName}\`;
      
      await this.context.redis.set(stateKey, JSON.stringify(data.state));
      
      await channel.send({
        type: 'roomstate_update',
        state: data.state
      });
      
      return { success: true };
    } catch (error: any) {
      console.error('[Realtime] updateRoomState error:', error);
      return { success: false, error: error.message };
    }
  }

  // USER IDENTITY HANDLERS
  
  private async handleGetUserInfo(data: { userId?: string, username?: string }) {
    try {
      let user;
      
      if (data.userId) {
        user = await this.context.reddit.getUserById(data.userId);
      } else if (data.username) {
        user = await this.context.reddit.getUserByUsername(data.username);
      } else {
        user = await this.context.reddit.getCurrentUser();
      }

      if (!user) {
        return { success: false, error: 'User not found' };
      }

      const snoovatarUrl = await this.context.reddit.getSnoovatarUrl(user.username);

      return {
        success: true,
        data: {
          id: user.id,
          username: user.username,
          avatarUrl: snoovatarUrl || this.getDefaultAvatar(),
          createdAt: user.createdAt
        }
      };
    } catch (error: any) {
      console.error('[User] getInfo error:', error);
      return { success: false, error: error.message };
    }
  }

  private async handleGetAvatar(data: { username: string }) {
    try {
      const snoovatarUrl = await this.context.reddit.getSnoovatarUrl(data.username);
      return {
        success: true,
        data: snoovatarUrl || this.getDefaultAvatar()
      };
    } catch (error: any) {
      console.error('[User] getAvatar error:', error);
      return { success: false, error: error.message, data: this.getDefaultAvatar() };
    }
  }

  private async handleGetCurrentUser(_data: any) {
    try {
      const user = await this.context.reddit.getCurrentUser();
      
      if (!user) {
        return {
          success: true,
          data: {
            id: 'anonymous',
            username: 'Guest',
            avatarUrl: this.getDefaultAvatar(),
            isAnonymous: true
          }
        };
      }

      const snoovatarUrl = await this.context.reddit.getSnoovatarUrl(user.username);

      return {
        success: true,
        data: {
          id: user.id,
          username: user.username,
          avatarUrl: snoovatarUrl || this.getDefaultAvatar(),
          isAnonymous: false
        }
      };
    } catch (error: any) {
      console.error('[User] getCurrentUser error:', error);
      return { 
        success: false, 
        error: error.message,
        data: {
          id: 'anonymous',
          username: 'Guest',
          avatarUrl: this.getDefaultAvatar(),
          isAnonymous: true
        }
      };
    }
  }

  private getDefaultAvatar(): string {
    return 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ccircle cx="50" cy="50" r="50" fill="%233b82f6"/%3E%3Ctext x="50" y="50" text-anchor="middle" dy=".3em" fill="white" font-size="40" font-family="Arial"%3E?%3C/text%3E%3C/svg%3E';
  }
}
`;

