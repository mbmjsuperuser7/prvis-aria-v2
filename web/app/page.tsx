/**
 * Home page — server component.
 * Renders AriaChat with server-resolved config.
 * CiD assembly happens in the server action (actions/chat.ts), not here.
 */
import AriaChat from '@/components/AriaChat'

export default function Home() {
  return (
    <AriaChat
      customerId={process.env.DEFAULT_CUSTOMER_ID || 'demo-customer'}
      apiUrl="/api/aria"
      healthUrl="/api/health"
      mode="full"
    />
  )
}
