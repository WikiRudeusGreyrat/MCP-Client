export interface ServerConfig {
  name: string;
  type: 'command' | 'sse';
  command?: string;
  url?: string;
  isOpen?: boolean;
}

export const config: ServerConfig[] = [
  {
    name: 'mongo-server',
    type: 'command',
    command: 'node D:\\MCP-Client\\node_modules\\mcp-mongo-server\\build\\index.js mongodb://localhost:27017/luoke-goods?authSource=admin',
    isOpen: true
  },
  // 你可以保留其他服务器配置或删除
  /*
  {
    name: 'demo-sse',
    type: 'sse',
    url: 'http://localhost:3001/sse',
    isOpen: false
  }
  */
];

export default config;