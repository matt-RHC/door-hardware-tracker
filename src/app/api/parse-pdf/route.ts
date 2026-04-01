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
      max_tokens: 4096,
      system: `You are an expert at extracting door hardware information from architectural submittals and schedules.
Extract all openings and their associated hardware items from the provided PDF document.
Return the data as valid JSON matching this structure exactly:
{
  "openings": [
    {
      "door_number": "string",
      "hw_set": "string",
      "hw_heading": "string",
      "location": "string",
      "door_type": "string",
      "frame_type": "string",
      "fire_rating": "string",
      "hand": "string",
      "hardware_items": [
        { "qty": number, "name": "string", "model": "string", "finish": "string", "manufacturer": "string" }
      ]
    }
  ]
}
Only return valid JSON, no other text.`,
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
              text: 'Extract all door openings and hardware items from this PDF document. Return only valid JSON.',
            },
          ],
        },
      ],
    })

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
      parsedData = JSON.parse(textContent.text)
    } catch (error) {
      return NextResponse.json(
        { error: 'Failed to parse Claude response as JSON' },
        { status: 500 }
      )
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

    return NextResponse.json({
      success: true,
      openingsCount,
      itemsCount,
    })
  } catch (error) {
    console.error('PDF parsing error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
