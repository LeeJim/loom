import { createServer } from 'node:http';

const tool = {
  name: 'workflow_stages',
  description: 'List the supported loom workflow stages.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
};
const stages = ['Planning', 'Coding', 'Validation', 'Repair', 'Review', 'Delivery'];

createServer(async (req, res) => {
  if (req.url !== '/mcp' || req.method !== 'POST') {
    res.writeHead(req.url === '/mcp' ? 405 : 404).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16384) {
      res.writeHead(413).end();
      return;
    }
  }
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    res.writeHead(400).end();
    return;
  }
  if (message.id === undefined) {
    res.writeHead(202).end();
    return;
  }
  let result;
  let error;
  switch (message.method) {
    case 'initialize':
      result = {
        protocolVersion: '2025-03-26', capabilities: { tools: {} },
        serverInfo: { name: 'loom-workflow', version: '1.0.0' },
      };
      break;
    case 'ping':
      result = {};
      break;
    case 'tools/list':
      result = { tools: [tool] };
      break;
    case 'tools/call':
      if (message.params?.name !== tool.name || Object.keys(message.params?.arguments ?? {}).length) {
        error = { code: -32602, message: 'Unknown tool or arguments' };
      } else {
        result = { content: [{ type: 'text', text: stages.join(', ') }] };
      }
      break;
    default:
      error = { code: -32601, message: 'Method not found' };
  }
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    jsonrpc: '2.0', id: message.id, ...(error ? { error } : { result }),
  }));
}).listen(3005, '0.0.0.0');
