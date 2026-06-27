import AriaChat from '@/components/AriaChat'

export default function Home() {
  return (
    <AriaChat
      customerId={process.env.DEFAULT_CUSTOMER_ID || 'demo-customer'}
      healthUrl="/api/health"
      mode="full"
    />
  )
}
