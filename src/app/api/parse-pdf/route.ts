import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

interface HardwareItem {
  qty: number
  name: string
  model: string
  finish: string
  manufacturer: string
}

interface Opening {
  door_number: string
  hw_set: string
  hw_heading: string
  location: string
  door_type: string
  frame_type: string
  fire_rating: string
  hand: string
  hardware_items: HardwareItem[]
}

interface ParsedContent {
  openings: Opening[]
}

export async function POST(request: NextRequest) {
  try {
    const supabase = await createServerSupabaseClient()

    // Check authentication
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // Parse form data
    const formData = await request.formData()
    const file = formData.get('file') as File
    const projectId = formData.get('projectId') as string

    if (!file || !projectId) {
      return NextResponse.json(
        { error: 'Missing file or projectId' },
        { status: 400 }
      )
    }

    if (file.type !== 'application/pdf') {
      return NextResponse.json(
        { error: 'File must be a PDF' },
        { status: 400 }
      )
    }

    // Convert file to base64
    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString('base64')

    // Initialize Anthropic client
    const client = new Anthropic()

    // Call Claude API with PDF
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 32768,
      system: `You are an expert at extracting door hardware information from architectural submittals and schedules.

CRITICAL: You MUST extract EVERY SINGLE opening/door from the ENTIRE document. Do NOT stop early or skip any pages. Go through ALL pages of the PDF from start to finish.

The PDF typically contains:
- A hardware set schedule listing each hardware set (e.g. DH1, DH2, EX1) with its hardware items
- A door schedule or opening index listing every door number and which hardware set it belongs to

For each unique door/opening listed, create an entry with ALL hardware items from its hardware set.

Return the data as valid JSON matching this structure exactly:
{
  "openings": [
    {
      "door_number": "string (e.g. 110-01A, 1201A, ST-1C)",
      "hw_set": "string (e.g. DH1-10, EX3-NR)",
      "hw_heading": "string (the hardware set description/heading)",
      "location": "string (room name/location if listed)",
      "door_type": "string (e.g. WD, HM, AL)",
      "frame_type": "string (e.g. HM, AL, WD)",
      "fire_rating": "string (e.g. 20Min, 45Min, 90Min, NR)",
      "hand": "string (e.g. A, LHR, RHR)",
      "hardware_items": [
        { "qty": number, "name": "string (e.g. Hinges, Closer, Lockset)", "model": "string", "finish": "string", "manufacturer": "string (2-letter abbreviation)" }
      ]
    }
  ]
}

IMPORTANT:
- Extract ALL openings, not just a sample. There may be 30-100+ openings.
- Each opening must have its complete hardware_items array populated from its hardware set.
- Only return valid JSON, no other text or markdown formatting.`,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: base64,
              },
            },
            {
              type: 'text',
              text: 'Extract EVERY door opening and ALL hardware items from this entire PDF document. Do not skip any doors or pages. Return only valid JSON.',
            },
          ],
        },
      ],
    })

    // Check if response was truncated
    if (response.stop_reason === 'max_tokens') {
      console.error('Claude response was truncated (hit max_tokens limit)')
      return NextResponse.json(
        { error: 'PDF too large - Claude response was truncated. Try uploading fewer pages.' },
        { status: 413 }
      )
    }

    // Extract JSON from response
    const textContent = response.content.find((block) => block.type === 'text')
    if (!textContent || textContent.type !== 'text') {
      return NextResponse.json(
        { error: 'Failed to get text response from Claude' },
        { status: 500 }
      )
    }

    let parsedData: ParsedContent
    try {
      // Strip markdown code fences if present (```json ... ```)
      let jsonText = textContent.text.trim()
      if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '')
      }
      parsedData = JSON.parse(jsonText)
    } catch (parseErr) {
      console.error('Failed to parse Claude response:', textContent.text.substring(0, 500))
      return NextResponse.json(
        { error: 'Failed to parse Claude response as JSON', detail: String(parseErr) },
        { status: 500 }
      )
    }

    // Delete existing openings for this project (cascade deletes hardware_items, checklist_progress, attachments)
    const { error: deleteError } = await (supabase as any)
      .from('openings')
      .delete()
      .eq('project_id', projectId)

    if (deleteError) {
      console.error('Error deleting existing openings:', deleteError)
    }

    // Log parsing results
    console.log(`Parsed ${parsedData.openings.length} openings from PDF`)
    if (parsedData.openings.length > 0) {
      const firstOpening = parsedData.openings[0]
      console.log(`First opening: ${firstOpening.door_number}, hardware_items: ${firstOpening.hardware_items?.length ?? 0}`)
    }

    // Insert openings and hardware items
    let openingsCount = 0
    let itemsCount = 0

    for (const opening of parsedData.openings) {
      // Insert opening
      const { data: insertedOpening, error: openingError } = await (supabase as any)
        .from('openings')
        .insert([{
          project_id: projectId,
          door_number: opening.door_number,
          hw_set: opening.hw_set || null,
          hw_heading: opening.hw_heading || null,
          location: opening.location || null,
          door_type: opening.door_type || null,
          frame_type: opening.frame_type || null,
          fire_rating: opening.fire_rating || null,
          hand: opening.hand || null,
        }] as any)
        .select()
        .single()

      if (openingError) {
        console.error('Error inserting opening:', openingError)
        continue
      }

      if (insertedOpening) {
        openingsCount++

        // Insert hardware items for this opening
        if (!opening.hardware_items || opening.hardware_items.length === 0) {
          console.log(`Opening ${opening.door_number}: no hardware items to insert`)
          continue
        }

        const hardwareInserts = opening.hardware_items.map((item: any, index: number) => ({
          opening_id: insertedOpening.id,
          name: item.name,
          qty: item.qty || 1,
          manufacturer: item.manufacturer || null,
          model: item.model || null,
          finish: item.finish || null,
          sort_order: index,
        }))

        const { error: itemsError, data: insertedItems } = await (supabase as any)
          .from('hardware_items')
          .insert(hardwareInserts as any)
          .select()

        if (!itemsError && insertedItems) {
          itemsCount += insertedItems.length
        } else if (itemsError) {
          console.error('Error inserting hardware items:', itemsError)
        }
      }
    }

    console.log(`PDF parse complete: ${openingsCount} openings, ${itemsCount} hardware items inserted`)

    return NextResponse.json({
      success: true,
      openingsCount,
      itemsCount,
    })
  } catch (error) {
    console.error('PDF parsing error:', error)
    const message = error instanceof Error ? error.message : 'Internal server error'
    return NextResponse.json(
      { error: message },
      { status: 500 }
    )
  }
}
