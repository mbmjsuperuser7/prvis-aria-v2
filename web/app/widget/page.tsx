import AriaChat from '@/components/AriaChat'

export default function Widget() {
  return (
    <AriaChat
      customerId={process.env.DEFAULT_CUSTOMER_ID || 'demo-customer'}
      healthUrl="/api/health"
      mode="widget"
    />
  )
}
