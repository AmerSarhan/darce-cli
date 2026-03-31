import { register } from './registry.js'
import { ReadTool } from './ReadTool.js'
import { WriteTool } from './WriteTool.js'
import { EditTool } from './EditTool.js'
import { BashTool } from './BashTool.js'
import { GlobTool } from './GlobTool.js'
import { GrepTool } from './GrepTool.js'
import { WebFetchTool } from './WebFetchTool.js'

export function registerAllTools() {
  register(ReadTool)
  register(WriteTool)
  register(EditTool)
  register(BashTool)
  register(GlobTool)
  register(GrepTool)
  register(WebFetchTool)
}

export { ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, WebFetchTool }
