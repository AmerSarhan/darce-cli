import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { MODEL_PROFILES } from '../config/models.js'

type Props = {
  currentModel: string
  onSelect: (model: string) => void
  onClose: () => void
}

export function ModelPicker({ currentModel, onSelect, onClose }: Props) {
  const [selected, setSelected] = useState(
    Math.max(0, MODEL_PROFILES.findIndex(m => m.id === currentModel))
  )

  useInput((ch, key) => {
    if (key.escape) { onClose(); return }
    if (key.return) { onSelect(MODEL_PROFILES[selected]!.id); return }
    if (key.upArrow) { setSelected(s => Math.max(0, s - 1)); return }
    if (key.downArrow) { setSelected(s => Math.min(MODEL_PROFILES.length - 1, s + 1)); return }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Select Model (↑↓ Enter, Esc to cancel)</Text>
      <Text> </Text>
      {MODEL_PROFILES.map((model, i) => (
        <Box key={model.id}>
          <Text color={i === selected ? 'cyan' : 'white'} bold={i === selected}>
            {i === selected ? '▸ ' : '  '}
            {model.id}
          </Text>
          <Text color="gray" dimColor>
            {' '}({model.strengths.join(', ')}) ${model.costPer1kOutput}/1k out
          </Text>
          {model.id === currentModel && <Text color="green"> ●</Text>}
        </Box>
      ))}
    </Box>
  )
}
