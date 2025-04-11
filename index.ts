import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, StdioServerParameters } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import OpenAI from "openai";
import { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ChatCompletionMessageParam } from "openai/resources/chat/completions.js";
import { createInterface } from "readline";
import { homedir } from 'os';
import dotenv from "dotenv";
import config, { ServerConfig } from "./server-config.js";

// 加载 .env 文件中的环境变量
dotenv.config();

// 初始化环境变量
const LLM_API_KEY = process.env.LLM_API_KEY;
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const LLM_MODEL = process.env.LLM_MODEL || '';  // 确保不为undefined

// 环境变量检查
if (!LLM_API_KEY) { throw new Error("环境变量 LLM_API_KEY 未设置"); }
if (!LLM_BASE_URL) { throw new Error("环境变量 LLM_BASE_URL 未设置"); }
if (!LLM_MODEL) { throw new Error("环境变量 LLM_MODEL 未设置"); }

interface MCPToolResult {
    content: string | any;
}

class MCPClient {
    static getOpenServers(): string[] {
        return config.filter((cfg: ServerConfig) => cfg.isOpen).map((cfg: ServerConfig) => cfg.name);
    }
    
    private sessions: Map<string, Client> = new Map();
    private transports: Map<string, StdioClientTransport | SSEClientTransport> = new Map();
    private openai: OpenAI;
    private messageHistory: ChatCompletionMessageParam[] = [];
    
    constructor() {
        this.openai = new OpenAI({
            apiKey: LLM_API_KEY,
            baseURL: LLM_BASE_URL
        });
        
        // 添加系统消息作为历史记录的第一条消息
        this.messageHistory.push({
            role: "system",
            content: "你是一个AI助手，可以帮助用户访问各种数据库和工具。请尽可能地记住我们的对话内容，并在回答问题时考虑到之前的对话历史。"
        });
    }
    
    async connectToServer(serverName: string): Promise<void> {
        const serverConfig = config.find((cfg: ServerConfig) => cfg.name === serverName) as ServerConfig;
        if (!serverConfig) {
            throw new Error(`Server configuration not found for: ${serverName}`);
        }
        
        let transport: StdioClientTransport | SSEClientTransport;
        if (serverConfig.type === 'command' && serverConfig.command) {
            transport = await this.createCommandTransport(serverConfig.command);
        } else if (serverConfig.type === 'sse' && serverConfig.url) {
            transport = await this.createSSETransport(serverConfig.url);
        } else {
            throw new Error(`Invalid server configuration for: ${serverName}`);
        }
        
        const client = new Client(
            {
                name: "mcp-client",
                version: "1.0.0"
            },
            {
                capabilities: {
                    prompts: {},
                    resources: {},
                    tools: {}
                }
            }
        );
        
        await client.connect(transport);
        
        this.sessions.set(serverName, client);
        this.transports.set(serverName, transport);
        
        // 列出可用工具
        const response = await client.listTools();
        console.log(`\nConnected to server '${serverName}' with tools:`, response.tools.map((tool: Tool) => tool.name));
    }
    
    private async createCommandTransport(shell: string): Promise<StdioClientTransport> {
        const [command, ...shellArgs] = shell.split(' ');
        if (!command) {
            throw new Error("Invalid shell command");
        }
        
        // 处理参数中的波浪号路径
        const args = shellArgs.map(arg => {
            if (arg.startsWith('~/')) {
                return arg.replace('~', homedir());
            }
            return arg;
        });
        
        const serverParams: StdioServerParameters = {
            command,
            args,
            env: Object.fromEntries(
                Object.entries(process.env).filter(([_, v]) => v !== undefined)
            ) as Record<string, string>
        };
        
        return new StdioClientTransport(serverParams);
    }
    
    private async createSSETransport(url: string): Promise<SSEClientTransport> {
        return new SSEClientTransport(new URL(url));
    }
    
    async processQuery(query: string): Promise<string> {
        if (this.sessions.size === 0) {
            throw new Error("Not connected to any server");
        }
        
        // 添加用户新的查询到历史
        this.messageHistory.push({
            role: "user",
            content: query
        });
        
        // 获取所有服务器的工具列表
        const availableTools: any[] = [];
        for (const [serverName, session] of this.sessions) {
            try {
                const response = await session.listTools();
                if (response.tools && Array.isArray(response.tools)) {
                    const tools = response.tools.map((tool: Tool) => ({
                        type: "function" as const,
                        function: {
                            name: `${serverName}__${tool.name}`,
                            description: `[${serverName}] ${tool.description || ''}`,
                            parameters: tool.inputSchema
                        }
                    }));
                    availableTools.push(...tools);
                }
            } catch (error) {
                console.error(`Failed to get tools from server ${serverName}:`, error);
            }
        }
        
        // 调用OpenAI API - 使用断言确保模型名称不为undefined
        const completion = await this.openai.chat.completions.create({
            model: LLM_MODEL as string,
            messages: this.messageHistory,
            tools: availableTools,
            tool_choice: "auto"
        });
        
        const finalText: string[] = [];
        
        // 处理OpenAI的响应
        for (const choice of completion.choices) {
            const message = choice.message;
            
            if (message.content) {
                finalText.push(message.content);
                
                // 添加助手的回复到历史
                this.messageHistory.push({
                    role: "assistant",
                    content: message.content
                });
            }
            
            if (message.tool_calls && message.tool_calls.length > 0) {
                // 添加带工具调用的助手消息到历史
                this.messageHistory.push({
                    role: "assistant",
                    content: "",
                    tool_calls: message.tool_calls
                });
                
                for (const toolCall of message.tool_calls) {
                    try {
                        const [serverName, toolName] = toolCall.function.name.split('__');
                        const session = this.sessions.get(serverName);
                        
                        if (!session) {
                            finalText.push(`[Error: Server ${serverName} not found]`);
                            continue;
                        }
                        
                        const toolArgs = JSON.parse(toolCall.function.arguments);
                        
                        // 执行工具调用
                        const result = await session.callTool({
                            name: toolName,
                            arguments: toolArgs
                        });
                        
                        const toolResult = result as unknown as MCPToolResult;
                        const toolResultContent = typeof toolResult.content === 'string' 
                            ? toolResult.content 
                            : JSON.stringify(toolResult.content);
                        
                        finalText.push(`[Calling tool ${toolName} on server ${serverName} with args ${JSON.stringify(toolArgs)}]`);
                        console.log(toolResultContent);
                        finalText.push(toolResultContent);
                        
                        // 添加工具结果到历史
                        this.messageHistory.push({
                            role: "tool",
                            tool_call_id: toolCall.id,
                            content: toolResultContent
                        });
                        
                        // 获取下一个响应 - 使用断言确保模型名称不为undefined
                        const nextCompletion = await this.openai.chat.completions.create({
                            model: LLM_MODEL as string,
                            messages: this.messageHistory,
                            tools: availableTools,
                            tool_choice: "auto"
                        });
                        
                        if (nextCompletion.choices[0].message.content) {
                            finalText.push(nextCompletion.choices[0].message.content);
                            
                            // 添加最终响应到历史
                            this.messageHistory.push({
                                role: "assistant",
                                content: nextCompletion.choices[0].message.content
                            });
                        }
                    } catch (error: any) {  // 使用 any 类型，以便能够访问 message 属性
                        console.error("Error during tool call processing:", error);
                        finalText.push(`[Error: ${error?.message || "Unknown error during tool execution"}]`);
                    }
                }
            }
        }
        
        return finalText.join("\n");
    }
    
    // 清除对话历史
    clearHistory(): void {
        this.messageHistory = [{
            role: "system",
            content: "你是一个AI助手，可以帮助用户访问各种数据库和工具。请尽可能地记住我们的对话内容，并在回答问题时考虑到之前的对话历史。"
        }];
        console.log("\n对话历史已清除");
    }
    
    async chatLoop(): Promise<void> {
        console.log("\nMCP Client Started!");
        console.log("Type your queries or 'quit' to exit. Type 'clear' to clear conversation history.");
        
        const readline = createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        const askQuestion = () => {
            return new Promise<string>((resolve) => {
                readline.question("\nQuery: ", resolve);
            });
        };
        
        try {
            while (true) {
                const query = (await askQuestion()).trim();
                if (query.toLowerCase() === 'quit') {
                    break;
                }
                
                if (query.toLowerCase() === 'clear') {
                    this.clearHistory();
                    continue;
                }
                
                if (!query) {
                    continue; // 跳过空查询
                }
                
                try {
                    const response = await this.processQuery(query);
                    console.log("\n" + response);
                } catch (error) {
                    console.error("\nError:", error);
                }
            }
        } finally {
            readline.close();
        }
    }
    
    async cleanup(): Promise<void> {
        for (const transport of this.transports.values()) {
            try {
                await transport.close();
            } catch (error) {
                console.error("Error closing transport:", error);
            }
        }
        
        this.transports.clear();
        this.sessions.clear();
    }
    
    hasActiveSessions(): boolean {
        return this.sessions.size > 0;
    }
}

// 主函数
async function main() {
    const openServers = MCPClient.getOpenServers();
    console.log("Connecting to servers:", openServers.join(", "));
    const client = new MCPClient();
    
    try {
        // 连接所有开启的服务器
        for (const serverName of openServers) {
            try {
                await client.connectToServer(serverName);
            } catch (error) {
                console.error(`Failed to connect to server '${serverName}':`, error);
            }
        }
        
        if (!client.hasActiveSessions()) {
            throw new Error("Failed to connect to any server");
        }
        
        await client.chatLoop();
    } finally {
        await client.cleanup();
    }
}

// 运行主函数
main().catch(console.error);
