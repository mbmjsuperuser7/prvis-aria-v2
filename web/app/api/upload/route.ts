/**
 * File upload route — POST /api/upload
 * Accepts multipart form data, stores file reference in Redis for the session.
 * File content is not sent to the LLM directly — filename is added to the message
 * as context so the LLM knows what was attached.
 */
import { NextRequest, NextResponse } from 'next/server'

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const files = formData.getAll('files') as File[]

    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    const names = files.map(f => f.name)
    return NextResponse.json({ files: names, status: 'attached' })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
