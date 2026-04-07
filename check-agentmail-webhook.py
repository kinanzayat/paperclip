#!/usr/bin/env python3
"""
Check AgentMail webhook configuration and diagnose issues.
Run this to see what's wrong with your webhook.
"""

import os
from agentmail import AgentMail

# Get API key from environment
api_key = os.getenv("AGENTMAIL_API_KEY")
if not api_key:
    print("❌ ERROR: AGENTMAIL_API_KEY environment variable not set!")
    print("\nSet it with:")
    print('  Windows PowerShell: $env:AGENTMAIL_API_KEY="your-key-here"')
    print('  Windows CMD: set AGENTMAIL_API_KEY=your-key-here')
    print('  Mac/Linux: export AGENTMAIL_API_KEY="your-key-here"')
    exit(1)

client = AgentMail(api_key=api_key)

print("=" * 80)
print("AGENTMAIL WEBHOOK DIAGNOSTIC")
print("=" * 80)

# 1. List all inboxes
print("\n📬 YOUR INBOXES:")
print("-" * 80)
try:
    inboxes = client.inboxes.list()
    if not inboxes.inboxes:
        print("❌ No inboxes found!")
    else:
        for inbox in inboxes.inboxes:
            print(f"  📧 {inbox.inbox_id}")
            print(f"     Email: {inbox.email_address}")
            print()
except Exception as e:
    print(f"❌ Error listing inboxes: {e}")

# 2. List all webhooks
print("\n🪝 YOUR WEBHOOKS:")
print("-" * 80)
try:
    webhooks = client.webhooks.list()
    if not webhooks.webhooks:
        print("❌ No webhooks configured!")
    else:
        for i, webhook in enumerate(webhooks.webhooks, 1):
            print(f"\n  Webhook #{i}")
            print(f"    ID: {webhook.webhook_id}")
            print(f"    URL: {webhook.url}")
            print(f"    Event Types: {webhook.event_types}")
            
            # THIS IS THE KEY ISSUE
            if hasattr(webhook, 'inbox_ids') and webhook.inbox_ids:
                print(f"    ⚠️  Inbox IDs: {webhook.inbox_ids}")
                print(f"    ⚠️  THIS WEBHOOK ONLY LISTENS TO SPECIFIC INBOXES!")
            else:
                print(f"    ✅ Listening to: ALL INBOXES")
except Exception as e:
    print(f"❌ Error listing webhooks: {e}")

# 3. The diagnosis
print("\n" + "=" * 80)
print("DIAGNOSIS")
print("=" * 80)

try:
    webhooks = client.webhooks.list()
    inboxes = client.inboxes.list()
    
    if not webhooks.webhooks:
        print("\n❌ PROBLEM: You have NO webhooks configured!")
        print("\nSolution: Create a webhook first:")
        print("  webhook = client.webhooks.create(")
        print("      url='https://jackets-cruises-vegas-hearings.trycloudflare.com/api/companies/1ec0b6dd-9e1d-4fd5-9b0d-37324447b928/webhooks/agentmail',")
        print("      event_types=['message.received']")
        print("  )")
    else:
        webhook = webhooks.webhooks[0]
        
        # Check if webhook is scoped to specific inboxes
        if hasattr(webhook, 'inbox_ids') and webhook.inbox_ids:
            print(f"\n⚠️  PROBLEM: Webhook is limited to inbox IDs: {webhook.inbox_ids}")
            print("\n✅ SOLUTION: Recreate the webhook without inbox_ids:")
            print(f"\n  # First, delete the old webhook:")
            print(f"  client.webhooks.delete('{webhook.webhook_id}')")
            print(f"\n  # Then create new one that listens to ALL inboxes:")
            print(f"  webhook = client.webhooks.create(")
            print(f"      url='{webhook.url}',")
            print(f"      event_types={webhook.event_types}")
            print(f"  )")
        elif 'message.received' not in webhook.event_types:
            print(f"\n⚠️  PROBLEM: Webhook is NOT subscribed to 'message.received'!")
            print(f"  Current events: {webhook.event_types}")
            print(f"\n✅ SOLUTION: Recreate webhook with 'message.received':")
            print(f"\n  client.webhooks.delete('{webhook.webhook_id}')")
            print(f"\n  webhook = client.webhooks.create(")
            print(f"      url='{webhook.url}',")
            print(f"      event_types=['message.received']")
            print(f"  )")
        else:
            print("\n✅ Webhook configuration looks correct!")
            print("\n📝 Next steps:")
            print("  1. Send a test email to one of your inboxes")
            print("  2. Wait 30 seconds")
            print("  3. Check AgentMail dashboard → Webhooks → Message Attempts")
            print("  4. If still no events, check Paperclip server logs")
            
except Exception as e:
    print(f"\n❌ Error during diagnosis: {e}")

print("\n" + "=" * 80)
