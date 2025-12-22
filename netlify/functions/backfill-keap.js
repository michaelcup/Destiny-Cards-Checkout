// netlify/functions/backfill-keap.js
// One-time backfill function to sync missed Stripe orders to Keap

const Stripe = require('stripe');

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }
  return new Stripe(secretKey);
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed. Use POST.' }) };
  }

  // Auth check
  const authHeader = event.headers['authorization'];
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey || authHeader !== `Bearer ${adminKey}`) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const keapToken = process.env.KEAP_ACCESS_TOKEN;
  if (!keapToken) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'KEAP_ACCESS_TOKEN not configured' }) };
  }

  // Parse options from request body
  let options = {};
  try {
    options = JSON.parse(event.body || '{}');
  } catch (e) {
    // Use defaults
  }

  const dryRun = options.dryRun !== false; // Default to dry run for safety
  const limit = options.limit || 100;

  try {
    const stripe = getStripe();
    const results = {
      processed: 0,
      synced: 0,
      skipped: 0,
      errors: [],
      details: []
    };

    console.log(`Starting backfill (dryRun: ${dryRun}, limit: ${limit})`);

    // Fetch completed checkout sessions
    const sessions = await stripe.checkout.sessions.list({
      status: 'complete',
      limit: limit
    });

    console.log(`Found ${sessions.data.length} completed sessions`);

    for (const sessionSummary of sessions.data) {
      results.processed++;

      try {
        // Retrieve full session details
        const session = await stripe.checkout.sessions.retrieve(sessionSummary.id);

        // Handle both old and new Stripe API versions for shipping
        const shippingDetails = session.shipping_details || session.collected_information?.shipping_details;

        const customerEmail = session.customer_details?.email;
        const customerName = session.customer_details?.name || '';

        if (!customerEmail) {
          results.skipped++;
          results.details.push({
            sessionId: session.id,
            status: 'skipped',
            reason: 'No customer email'
          });
          continue;
        }

        // Check if contact exists in Keap and has order data
        const existingContact = await findKeapContact(keapToken, customerEmail);
        const hasOrderData = existingContact && hasExistingOrderData(existingContact);

        if (hasOrderData) {
          results.skipped++;
          results.details.push({
            sessionId: session.id,
            email: customerEmail,
            status: 'skipped',
            reason: 'Already has order data in Keap'
          });
          continue;
        }

        // Parse cart items from metadata
        let cartItems = [];
        let hasPreOrder = false;
        try {
          cartItems = JSON.parse(session.metadata?.cartItems || '[]');
          hasPreOrder = session.metadata?.hasPreOrder === 'true';
        } catch (e) {
          console.error('Failed to parse cart items for session:', session.id);
        }

        const orderData = {
          sessionId: session.id,
          email: customerEmail,
          name: customerName,
          shippingAddress: shippingDetails?.address ? {
            line1: shippingDetails.address.line1,
            line2: shippingDetails.address.line2 || '',
            city: shippingDetails.address.city,
            state: shippingDetails.address.state,
            postalCode: shippingDetails.address.postal_code,
            country: shippingDetails.address.country
          } : null,
          cartItems,
          hasPreOrder,
          amountPaid: session.amount_total / 100,
          paymentId: session.payment_intent,
          created: new Date(session.created * 1000).toISOString()
        };

        if (dryRun) {
          results.synced++;
          results.details.push({
            sessionId: session.id,
            email: customerEmail,
            name: customerName,
            status: 'would_sync',
            orderData
          });
        } else {
          // Actually sync to Keap
          await syncToKeap(keapToken, orderData, session.metadata?.emailConsent === 'true');
          results.synced++;
          results.details.push({
            sessionId: session.id,
            email: customerEmail,
            status: 'synced'
          });
        }

      } catch (sessionError) {
        results.errors.push({
          sessionId: sessionSummary.id,
          error: sessionError.message
        });
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        dryRun,
        message: dryRun
          ? `Dry run complete. ${results.synced} orders would be synced. Run with dryRun: false to execute.`
          : `Backfill complete. ${results.synced} orders synced to Keap.`,
        results
      }, null, 2)
    };

  } catch (error) {
    console.error('Backfill error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Backfill failed', message: error.message })
    };
  }
};

// Find contact in Keap by email
async function findKeapContact(accessToken, email) {
  const response = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/contacts?email=${encodeURIComponent(email)}&optional_properties=custom_fields`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!response.ok) {
    if (response.status === 429) {
      // Rate limited - wait and retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      return findKeapContact(accessToken, email);
    }
    return null;
  }

  const data = await response.json();
  return data.contacts?.[0] || null;
}

// Check if contact has existing order data
function hasExistingOrderData(contact) {
  const customFields = contact.custom_fields || [];
  // Check for PAYMENT_ID field (311) - if this exists, they have order data
  const paymentIdField = customFields.find(f => f.id === 311);
  return !!(paymentIdField?.content);
}

// Sync order to Keap (same logic as webhook)
async function syncToKeap(accessToken, orderData, emailConsent) {
  const {
    email,
    name,
    shippingAddress,
    cartItems,
    hasPreOrder,
    amountPaid,
    paymentId,
    created
  } = orderData;

  // Split name
  const nameParts = name.split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Format shipping address
  const shippingAddressFormatted = shippingAddress
    ? `${shippingAddress.line1}${shippingAddress.line2 ? '\n' + shippingAddress.line2 : ''}\n${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.postalCode}\n${shippingAddress.country}`
    : 'Not provided';

  // Build order summary
  const orderSummary = cartItems.map(item =>
    `${item.quantity}x ${item.productName}`
  ).join('\n');

  const totalPrice = cartItems.reduce((sum, item) =>
    sum + (item.productPrice * item.quantity), 0
  );

  const productIds = cartItems.map(item => item.productId).join(', ');

  // Custom field IDs
  const CUSTOM_FIELDS = {
    PRODUCT_ORDERED: 303,
    ORDER_SUMMARY: 305,
    PRODUCT_PRICE: 307,
    SHIPPING_ADDRESS: 309,
    PAYMENT_ID: 311,
    ORDER_DATE: 313,
    HAS_PREORDER: 323,
    ORDER_HISTORY: 325,
    TOTAL_SPENT: 327
  };

  // Format order for history
  const orderDate = new Date(created);
  const orderDateFormatted = orderDate.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const orderHistoryEntry = `${orderDateFormatted}: ${orderSummary.replace('\n', ', ')} ($${amountPaid.toFixed(2)})`;

  const customFields = [
    { id: CUSTOM_FIELDS.PRODUCT_ORDERED, content: productIds },
    { id: CUSTOM_FIELDS.ORDER_SUMMARY, content: orderSummary },
    { id: CUSTOM_FIELDS.PRODUCT_PRICE, content: totalPrice.toString() },
    { id: CUSTOM_FIELDS.SHIPPING_ADDRESS, content: shippingAddressFormatted },
    { id: CUSTOM_FIELDS.PAYMENT_ID, content: paymentId },
    { id: CUSTOM_FIELDS.ORDER_DATE, content: orderDate.toISOString().split('T')[0] },
    { id: CUSTOM_FIELDS.HAS_PREORDER, content: hasPreOrder ? 'Yes' : 'No' },
    { id: CUSTOM_FIELDS.ORDER_HISTORY, content: orderHistoryEntry },
    { id: CUSTOM_FIELDS.TOTAL_SPENT, content: amountPaid.toFixed(2) }
  ];

  // Build native address object
  const addresses = shippingAddress ? [{
    field: 'SHIPPING',
    line1: shippingAddress.line1,
    line2: shippingAddress.line2 || '',
    locality: shippingAddress.city,
    region: shippingAddress.state,
    postal_code: shippingAddress.postalCode,
    country_code: shippingAddress.country
  }] : [];

  const contactPayload = {
    given_name: firstName,
    family_name: lastName,
    email_addresses: [{ email: email, field: 'EMAIL1' }],
    addresses: addresses,
    opt_in_reason: emailConsent ? 'Destiny Cards Purchase' : null,
    custom_fields: customFields
  };

  // Search for existing contact
  const existingContact = await findKeapContact(accessToken, email);
  let contactId;

  if (existingContact) {
    // Update existing contact
    contactId = existingContact.id;
    const updateResponse = await fetch(
      `https://api.infusionsoft.com/crm/rest/v1/contacts/${contactId}`,
      {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(contactPayload)
      }
    );

    if (!updateResponse.ok) {
      throw new Error(`Contact update failed: ${updateResponse.status}`);
    }
  } else {
    // Create new contact
    const createResponse = await fetch(
      'https://api.infusionsoft.com/crm/rest/v1/contacts',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(contactPayload)
      }
    );

    if (!createResponse.ok) {
      throw new Error(`Contact creation failed: ${createResponse.status}`);
    }

    const newContact = await createResponse.json();
    contactId = newContact.id;
  }

  // Apply tags
  const tags = [
    'Destiny Cards - Order Received',
    'Destiny Cards - 1st Edition',
    'Destiny Cards - Awaiting Shipment'
  ];

  for (const item of cartItems) {
    if (item.productId === 'cards-only') {
      tags.push('Destiny Cards - Cards Only');
    } else if (item.productId === 'cards-book-bundle') {
      tags.push('Destiny Cards - Cards + Book Bundle');
    }
  }

  if (hasPreOrder) {
    tags.push('Destiny Cards - Pre-Order (Book Ships March 2026)');
    tags.push('Destiny Cards - Pending Book Shipment');
  }

  // Add date tag based on order date
  const monthYear = orderDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  tags.push(`Destiny Cards - ${monthYear}`);

  // Apply each tag
  for (const tagName of tags) {
    try {
      const tagId = await getOrCreateTag(accessToken, tagName);
      await applyTagToContact(accessToken, contactId, tagId);
      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (tagError) {
      console.error(`Failed to apply tag "${tagName}":`, tagError.message);
    }
  }

  return { success: true, contactId };
}

async function getOrCreateTag(accessToken, tagName) {
  const searchResponse = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/tags?name=${encodeURIComponent(tagName)}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );

  if (!searchResponse.ok) {
    if (searchResponse.status === 429) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      return getOrCreateTag(accessToken, tagName);
    }
    throw new Error(`Tag search failed: ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json();

  if (searchData.tags && searchData.tags.length > 0) {
    return searchData.tags[0].id;
  }

  // Create new tag
  const createResponse = await fetch(
    'https://api.infusionsoft.com/crm/rest/v1/tags',
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: tagName,
        description: `Auto-created for Destiny Cards - ${new Date().toISOString()}`
      })
    }
  );

  if (!createResponse.ok) {
    throw new Error(`Tag creation failed: ${createResponse.status}`);
  }

  const newTag = await createResponse.json();
  return newTag.id;
}

async function applyTagToContact(accessToken, contactId, tagId) {
  const response = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/contacts/${contactId}/tags`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ tagIds: [tagId] })
    }
  );

  if (!response.ok && response.status !== 429) {
    throw new Error(`Tag application failed: ${response.status}`);
  }
}
