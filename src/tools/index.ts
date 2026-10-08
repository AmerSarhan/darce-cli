import { register } from './registry.js'
import { ReadTool } from './ReadTool.js'
import { WriteTool } from './WriteTool.js'
import { EditTool } from './EditTool.js'
import { BashTool } from './BashTool.js'
import { GlobTool } from './GlobTool.js'
import { GrepTool } from './GrepTool.js'
import { WebFetchTool } from './WebFetchTool.js'
import { WebSearchTool } from './WebSearchTool.js'
import { StealthFetchTool } from './StealthFetchTool.js'
import { SkillTool } from './SkillTool.js'
import { PlanTool } from './PlanTool.js'
import { RememberTool } from './RememberTool.js'
import { ImageTool } from './ImageTool.js'
import { scrapifyConfig } from '../web/scrapify.js'

export function registerAllTools() {
  register(ReadTool)
  register(WriteTool)
  register(EditTool)
  register(BashTool)
  register(GlobTool)
  register(GrepTool)
  register(WebFetchTool)
  register(WebSearchTool)
  register(SkillTool)
  register(PlanTool)
  register(RememberTool)
  register(ImageTool)
  // Only offered when stealth fetching is configured
  if (scrapifyConfig()) register(StealthFetchTool)
}

export { ReadTool, WriteTool, EditTool, BashTool, GlobTool, GrepTool, WebFetchTool, WebSearchTool, StealthFetchTool, SkillTool, PlanTool }
