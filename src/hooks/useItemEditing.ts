import { useState, useCallback } from 'react'
import { HardwareItemWithProgress } from '@/lib/types/database'

interface OpeningDetail {
  hardware_items: HardwareItemWithProgress[]
  [key: string]: any
}

export interface EditingItemState {
  itemId: string
  name: string
  qty: number
  manufacturer: string | null
  model: string | null
  finish: string | null
  options: string | null
  install_type: 'bench' | 'field' | null
}

export interface EditApplyAllPrompt {
  originalName: string
  updates: Record<string, string | null>
  totalCount: number
}

interface UseItemEditingOptions {
  projectId: string
  doorId: string
  opening: OpeningDetail | null
  fetchOpeningData: () => Promise<void>
}

export function useItemEditing({ projectId, doorId, opening, fetchOpeningData }: UseItemEditingOptions) {
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingItem, setEditingItem] = useState<EditingItemState | null>(null)
  const [savingItem, setSavingItem] = useState(false)
  const [originalItemName, setOriginalItemName] = useState<string | null>(null)
  const [editApplyAllPrompt, setEditApplyAllPrompt] = useState<EditApplyAllPrompt | null>(null)
  const [editApplyAllLoading, setEditApplyAllLoading] = useState(false)
  const [dontAskEditApplyAll, setDontAskEditApplyAll] = useState(false)

  const startEditItem = useCallback((item: HardwareItemWithProgress) => {
    setEditingItemId(item.id)
    setOriginalItemName(item.name)
    setEditingItem({
      itemId: item.id,
      name: item.name,
      qty: item.qty,
      manufacturer: item.manufacturer,
      model: item.model,
      finish: item.finish,
      options: item.options,
      install_type: item.install_type || null,
    })
  }, [])

  const cancelEditItem = useCallback(() => {
    setEditingItemId(null)
    setEditingItem(null)
    setOriginalItemName(null)
  }, [])

  const applyBulkItemUpdate = useCallback(async (originalName: string, updates: Record<string, string | null>) => {
    setEditApplyAllLoading(true)
    try {
      const response = await fetch(
        `/api/projects/${projectId}/bulk-update-items`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ original_name: originalName, updates }),
        }
      )
      if (!response.ok) throw new Error('Failed to bulk update items')
    } catch (err) {
      console.error('Error bulk updating items:', err)
      alert('Failed to apply the edit to all matching items. Check your connection and try again.')
    } finally {
      setEditApplyAllLoading(false)
      setEditApplyAllPrompt(null)
    }
  }, [projectId])

  const saveSingleItem = useCallback(async () => {
    if (!editingItem) return
    setSavingItem(true)
    try {
      const response = await fetch(
        `/api/openings/${doorId}/items/${editingItem.itemId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: editingItem.name,
            qty: editingItem.qty,
            manufacturer: editingItem.manufacturer,
            model: editingItem.model,
            finish: editingItem.finish,
            options: editingItem.options,
            install_type: editingItem.install_type,
          }),
        }
      )

      if (!response.ok) throw new Error('Failed to save item')
      await fetchOpeningData()
      setEditingItemId(null)
      setEditingItem(null)
      setOriginalItemName(null)
    } catch (err) {
      console.error('Error saving item:', err)
      alert('Failed to save item. Check your connection and try again.')
    } finally {
      setSavingItem(false)
    }
  }, [editingItem, doorId, fetchOpeningData])

  const saveEditItem = useCallback(async () => {
    if (!editingItem || !originalItemName) return

    // Build the updates object for text fields that changed
    const textUpdates: Record<string, string | null> = {}
    const origItem = opening?.hardware_items?.find(i => i.id === editingItem.itemId)
    if (origItem) {
      if (editingItem.name !== origItem.name) textUpdates.name = editingItem.name
      if (editingItem.manufacturer !== origItem.manufacturer) textUpdates.manufacturer = editingItem.manufacturer
      if (editingItem.model !== origItem.model) textUpdates.model = editingItem.model
      if (editingItem.finish !== origItem.finish) textUpdates.finish = editingItem.finish
      if (editingItem.options !== origItem.options) textUpdates.options = editingItem.options
    }

    const hasTextChanges = Object.keys(textUpdates).length > 0

    // If text fields changed, check for apply-to-all (unless "don't ask" is set)
    if (hasTextChanges && !dontAskEditApplyAll) {
      try {
        const countRes = await fetch(
          `/api/projects/${projectId}/classify-items?item_name=${encodeURIComponent(originalItemName)}`
        )
        if (countRes.ok) {
          const { total } = await countRes.json()
          if (total > 1) {
            setEditApplyAllPrompt({
              originalName: originalItemName,
              updates: textUpdates,
              totalCount: total,
            })
            return // Wait for user decision
          }
        }
      } catch {
        // Fall through to single save
      }
    }

    // If "don't ask" is set and there are text changes, apply to all silently
    if (hasTextChanges && dontAskEditApplyAll) {
      await applyBulkItemUpdate(originalItemName, textUpdates)
    }

    // Always save the full single item (includes qty, install_type, etc.)
    await saveSingleItem()
  }, [editingItem, originalItemName, opening, dontAskEditApplyAll, projectId, applyBulkItemUpdate, saveSingleItem])

  return {
    editingItemId,
    editingItem,
    setEditingItem,
    savingItem,
    editApplyAllPrompt,
    editApplyAllLoading,
    dontAskEditApplyAll,
    setDontAskEditApplyAll,
    startEditItem,
    cancelEditItem,
    saveEditItem,
    saveSingleItem,
    applyBulkItemUpdate,
  }
}
