export function getMainTsx(title, webviewPath) {
  return `import { Devvit, useState, useAsync } from '@devvit/public-api';
import { DevvitBridge } from './devvit-bridge.js';

Devvit.configure({
  redditAPI: true,
  redis: true,
  realtime: true,
  http: true,
});

// Track active bridges by post
const activeBridges = new Map<string, DevvitBridge>();

Devvit.addCustomPostType({
  name: '${title.replace(/'/g, "\\'")}',
  height: 'tall',
  render: (context) => {
    const postId = context.postId || 'preview';
    
    // Initialize bridge for this post if not exists
    if (!activeBridges.has(postId)) {
      activeBridges.set(postId, new DevvitBridge(context));
    }
    
    const bridge = activeBridges.get(postId)!;
    
    // Fetch user identity on mount
    const [userInfo, setUserInfo] = useState<any>(null);
    const [isReady, setIsReady] = useState(false);
    
    useAsync(async () => {
      try {
        // Get current user info with avatar
        const user = await context.reddit.getCurrentUser();
        
        if (user) {
          const snoovatarUrl = await context.reddit.getSnoovatarUrl(user.username);
          setUserInfo({
            id: user.id,
            username: user.username,
            avatarUrl: snoovatarUrl || getDefaultAvatar(),
            isAnonymous: false
          });
        } else {
          // Anonymous user
          setUserInfo({
            id: 'anonymous',
            username: 'Guest',
            avatarUrl: getDefaultAvatar(),
            isAnonymous: true
          });
        }
        
        setIsReady(true);
      } catch (error) {
        console.error('[Devvit] Failed to fetch user info:', error);
        // Fallback to guest
        setUserInfo({
          id: 'anonymous',
          username: 'Guest',
          avatarUrl: getDefaultAvatar(),
          isAnonymous: true
        });
        setIsReady(true);
      }
    }, { depends: [] });
    
    // Handle messages from webview
    const onMessage = async (event: any) => {
      const { type, data, messageId } = event.data;
      
      // console.log(\`[Devvit] Received message: \${type}\`);
      
      // Handle Console Bridge
      if (type === 'console') {
          console.log(...(event.data.args || []));
          return;
      }
      
      try {
        const result = await bridge.handleMessage(type, data);
        
        // Send response back to webview
        context.ui.webView.postMessage('game-webview', {
          type: 'devvit-response',
          data: { messageId, result }
        });
      } catch (error) {
        console.error(\`[Devvit] Error handling message \${type}:\`, error);
        context.ui.webView.postMessage('game-webview', {
          type: 'devvit-response',
          data: { 
            messageId, 
            error: error.message || 'Unknown error' 
          }
        });
      }
    };
    
    // Listen for realtime messages and forward to webview
    if (context.realtime) {
      const mainChannel = context.realtime.channel('post:main');
      
      useAsync(async () => {
        await mainChannel.subscribe((msg) => {
          // Forward realtime messages to webview
          context.ui.webView.postMessage('game-webview', {
            type: 'devvit-realtime',
            data: { message: msg }
          });
        });
      }, { depends: [] });
    }
    
    if (!isReady) {
      return (
        <vstack height="100%" width="100%" alignment="center middle">
          <text size="large">Loading Game...</text>
        </vstack>
      );
    }
    
    return (
      <vstack height="100%" width="100%">
        <webview
          id="game-webview"
          url="${webviewPath}"
          onMessage={onMessage}
          height="100%"
          width="100%"
        />
      </vstack>
    );
  },
});

function getDefaultAvatar(): string {
  return 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"%3E%3Ccircle cx="50" cy="50" r="50" fill="%233b82f6"/%3E%3Ctext x="50" y="50" text-anchor="middle" dy=".3em" fill="white" font-size="40" font-family="Arial"%3E?%3C/text%3E%3C/svg%3E';
}

// Menu action to create posts
Devvit.addMenuItem({
  label: 'Create ${title.replace(/'/g, "\\'")}',
  location: 'subreddit',
  onPress: async (_event, context) => {
    const { reddit, ui } = context;
    
    try {
      const subreddit = await reddit.getCurrentSubreddit();
      const post = await reddit.submitPost({
        title: '${title.replace(/'/g, "\\'")}',
        subredditName: subreddit.name,
        preview: (
          <vstack padding="medium" cornerRadius="medium" alignment="center middle">
            <text size="xlarge" weight="bold">${title.replace(/'/g, "\\'")}</text>
            <text color="neutral-content-weak">Click to play!</text>
          </vstack>
        ),
      });
      
      ui.showToast({ text: 'Post created!', appearance: 'success' });
      ui.navigateTo(post);
    } catch (error) {
      console.error('Error creating post:', error);
      ui.showToast({ text: 'Failed to create post', appearance: 'neutral' });
    }
  },
});

export default Devvit;
`;
}

