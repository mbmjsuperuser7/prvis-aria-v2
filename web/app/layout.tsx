import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Aria — prvis Security Assistant',
  description: 'AI-powered security assistant',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body style={{ margin: 0, padding: 0, background: '#0D0E10' }}>
        {children}
      </body>
    </html>
  )
}
