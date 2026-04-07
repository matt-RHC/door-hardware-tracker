import { useState, useCallback } from 'react'
import { HardwareItem, ChecklistProgress } from '@/lib/types/database'

interface HardwareItemWithProgress extends HardwareItem {
  progress?: ChecklistProgress
}

export interface ClassifyPrompt {
  itemId: string
  itemName: string
  installType: 'bench' | 'field'
  totalCount: number
}

interface UseClassificationOptions {
  projectId: string
  doorId: string
  opening: { hardware_items: HardwareItemWithProgress[] } | null
  fetchOpeningData: () => Promise<void>
}

export function useClassification({ projectId, doorId, opening, fetchOpeningData }: UseClassificationOptions) {
  const [classifyPrompt, setClassifyPrompt] = useState<ClassifyPrompt | null>(null)
  const [classifyLoading, setClassifyLoading] = useState(false)
  const [dontAskClassify, setDontAskClassify] = useState(false)

  const applySingleClassification = useCallback(async (itemId: string, installType: 'bench' | 'field') => {
    try {
      const response = await fetch(
        `/api/openings/${doorId}/items/${itemId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ install_type: installType }),
        }
      )
      if (!response.ok) throw new Error('Failed to update install type')
      await fetchOpeningData()
    } catch (err) {
      console.error('Error updating install type:', err)
    }
  }, [doorId, fetchOpeningData])

  const applyClassification = useCallback(async (itemName: string, installType: 'bench' | 'field', itemIds?: string[]) => {
    setClassifyLoading(true)
    try {
      const response = await fetch(
        `/api/projects/${projectId}/classify-items`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            item_name: itemName,
            install_type: installType,
            ...(itemIds ? { item_ids: itemIds } : {}),
          }),
        }
      )
      if (!response.ok) throw new Error('Failed to classify items')
      await fetchOpeningData()
    } catch (err) {
      console.error('Error classifying items:', err)
    } finally {
      setClassifyLoading(false)
      setClassifyPrompt(null)
    }
  }, [projectId, fetchOpeningData])

  const handleInstallTypeChange = useCallback(async (itemId: string, installType: 'bench' | 'field' | null) => {
    if (!installType || !opening) {
      // Clearing install type — just patch the single item
      try {
        const response = await fetch(
          `/api/openings/${doorId}/items/${itemId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ install_type: installType }),
          }
        )
        if (!response.ok) throw new Error('Failed to update install type')
        await fetchOpeningData()
      } catch (err) {
        console.error('Error updating install type:', err)
      }
      return
    }

    const item = (opening.hardware_items ?? []).find(i => i.id === itemId)
    if (!item) return

    // If user chose "don't ask again", apply to all silently
    if (dontAskClassify) {
      await applyClassification(item.name, installType)
      return
    }

    // Check how many matching items exist across the project
    try {
      const countRes = await fetch(
        `/api/projects/${projectId}/classify-items?item_name=${encodeURIComponent(item.name)}`
      )
      if (!countRes.ok) {
        // Fallback to single-item update
        await applySingleClassification(itemId, installType)
        return
      }
      const { total } = await countRes.json()

      if (total > 1) {
        // Show the prompt
        setClassifyPrompt({ itemId, itemName: item.name, installType, totalCount: total })
      } else {
        // Only one instance, just apply directly
        await applySingleClassification(itemId, installType)
      }
    } catch {
      await applySingleClassification(itemId, installType)
    }
  }, [opening, dontAskClassify, projectId, doorId, fetchOpeningData, applyClassification, applySingleClassification])

  return {
    classifyPrompt,
    setClassifyPrompt,
    classifyLoading,
    dontAskClassify,
    setDontAskClassify,
    handleInstallTypeChange,
    applySingleClassification,
    applyClassification,
  }
}
