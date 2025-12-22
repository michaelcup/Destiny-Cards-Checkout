// netlify/functions/stripe-webhook.js
// Handles Stripe webhooks for order fulfillment and Keap integration

const Stripe = require('stripe');

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }
  return new Stripe(secretKey);
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const sig = event.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let stripeEvent;

  try {
    // Verify webhook signature
    const stripe = getStripe();
    stripeEvent = stripe.webhooks.constructEvent(
      event.body,
      sig,
      webhookSecret
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return {
      statusCode: 400,
      body: JSON.stringify({ error: `Webhook Error: ${err.message}` })
    };
  }

  // Handle the event
  try {
    switch (stripeEvent.type) {
      case 'checkout.session.completed':
        await handleCheckoutComplete(stripeEvent.data.object);
        break;

      case 'checkout.session.async_payment_succeeded':
        await handleCheckoutComplete(stripeEvent.data.object);
        break;

      case 'checkout.session.async_payment_failed':
        console.log('Payment failed for session:', stripeEvent.data.object.id);
        break;

      default:
        console.log(`Unhandled event type: ${stripeEvent.type}`);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ received: true })
    };

  } catch (error) {
    console.error('Webhook handler error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Webhook handler failed' })
    };
  }
};

async function handleCheckoutComplete(sessionFromWebhook) {
  console.log('Processing completed checkout:', sessionFromWebhook.id);

  // Retrieve full session from Stripe API to get shipping details
  // (webhook payload doesn't include all fields by default)
  const stripe = getStripe();
  const session = await stripe.checkout.sessions.retrieve(sessionFromWebhook.id);

  // Handle both old and new Stripe API versions
  // Old: session.shipping_details
  // New (2025-03-31+): session.collected_information.shipping_details
  const shippingDetails = session.shipping_details || session.collected_information?.shipping_details;

  console.log('Full session shipping_details:', JSON.stringify(shippingDetails, null, 2));

  // Extract data from session
  const customerEmail = session.customer_details?.email;
  const customerName = session.customer_details?.name || '';
  const shippingAddress = shippingDetails?.address;
  const shippingName = shippingDetails?.name;
  const metadata = session.metadata || {};

  // Parse cart items from metadata
  let cartItems = [];
  try {
    cartItems = JSON.parse(metadata.cartItems || '[]');
  } catch (e) {
    console.error('Failed to parse cart items:', e);
  }

  const hasPreOrder = metadata.hasPreOrder === 'true';
  const emailConsent = metadata.emailConsent === 'true';

  // Split name into first/last
  const nameParts = customerName.split(' ');
  const firstName = nameParts[0] || '';
  const lastName = nameParts.slice(1).join(' ') || '';

  // Integrate with Keap
  try {
    await integrateWithKeap({
      firstName,
      lastName,
      email: customerEmail,
      emailConsent,
      cartItems,
      shippingAddress: shippingAddress ? {
        line1: shippingAddress.line1,
        line2: shippingAddress.line2 || '',
        city: shippingAddress.city,
        state: shippingAddress.state,
        postalCode: shippingAddress.postal_code,
        country: shippingAddress.country
      } : null,
      paymentId: session.payment_intent,
      amountPaid: session.amount_total / 100,
      hasPreOrder
    });
    console.log('Keap integration successful');
  } catch (keapError) {
    console.error('Keap integration failed:', keapError);
    // Don't throw - payment succeeded, we just log the Keap failure
  }
}

// Keap integration (same as before, but triggered by webhook)
async function integrateWithKeap(data) {
  const {
    firstName,
    lastName,
    email,
    emailConsent,
    cartItems,
    shippingAddress,
    paymentId,
    amountPaid,
    hasPreOrder
  } = data;

  const accessToken = process.env.KEAP_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error('Keap access token not configured');
  }

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

  // Custom field IDs - update these with your actual Keap field IDs
  const CUSTOM_FIELDS = {
    PRODUCT_ORDERED: 303,
    ORDER_SUMMARY: 305,
    PRODUCT_PRICE: 307,
    SHIPPING_ADDRESS: 309,
    PAYMENT_ID: 311,
    ORDER_DATE: 313,
    CARDS_TRACKING_NUMBER: 315,
    CARDS_SHIPPED_DATE: 317,
    BOOK_TRACKING_NUMBER: 319,
    BOOK_SHIPPED_DATE: 321,
    HAS_PREORDER: 323,
    ORDER_HISTORY: 325,
    TOTAL_SPENT: 327
  };

  // Search for existing contact
  const searchResponse = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/contacts?email=${encodeURIComponent(email)}`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!searchResponse.ok) {
    throw new Error(`Contact search failed: ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json();
  const isReturningCustomer = searchData.contacts && searchData.contacts.length > 0;

  // Format this order for history
  const orderDateFormatted = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });
  const thisOrderEntry = `${orderDateFormatted}: ${orderSummary} ($${amountPaid.toFixed(2)})`;

  // Initialize order history and total spent for this order
  let orderHistory = thisOrderEntry;
  let totalSpent = amountPaid;

  // If returning customer, fetch their current values and append/add
  if (isReturningCustomer) {
    const existingContactId = searchData.contacts[0].id;

    // Fetch full contact details to get custom field values
    const contactDetailResponse = await fetch(
      `https://api.infusionsoft.com/crm/rest/v1/contacts/${existingContactId}?optional_properties=custom_fields`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (contactDetailResponse.ok) {
      const contactDetail = await contactDetailResponse.json();
      const existingCustomFields = contactDetail.custom_fields || [];

      // Find existing ORDER_HISTORY value
      const existingHistoryField = existingCustomFields.find(f => f.id === CUSTOM_FIELDS.ORDER_HISTORY);
      if (existingHistoryField && existingHistoryField.content) {
        // Prepend new order to existing history (newest first)
        orderHistory = `${thisOrderEntry}\n---\n${existingHistoryField.content}`;
      }

      // Find existing TOTAL_SPENT value
      const existingSpentField = existingCustomFields.find(f => f.id === CUSTOM_FIELDS.TOTAL_SPENT);
      if (existingSpentField && existingSpentField.content) {
        const previousTotal = parseFloat(existingSpentField.content) || 0;
        totalSpent = previousTotal + amountPaid;
      }
    }

    console.log(`Returning customer detected. Total spent: $${totalSpent.toFixed(2)}`);
  }

  const customFields = [
    { id: CUSTOM_FIELDS.PRODUCT_ORDERED, content: productIds },
    { id: CUSTOM_FIELDS.ORDER_SUMMARY, content: orderSummary },
    { id: CUSTOM_FIELDS.PRODUCT_PRICE, content: totalPrice.toString() },
    { id: CUSTOM_FIELDS.SHIPPING_ADDRESS, content: shippingAddressFormatted },
    { id: CUSTOM_FIELDS.PAYMENT_ID, content: paymentId },
    { id: CUSTOM_FIELDS.ORDER_DATE, content: new Date().toISOString().split('T')[0] },
    { id: CUSTOM_FIELDS.HAS_PREORDER, content: hasPreOrder ? 'Yes' : 'No' },
    { id: CUSTOM_FIELDS.ORDER_HISTORY, content: orderHistory },
    { id: CUSTOM_FIELDS.TOTAL_SPENT, content: totalSpent.toFixed(2) }
  ];

  // Build native address object for Keap contact
  const addresses = shippingAddress ? [{
    field: 'SHIPPING',
    line1: shippingAddress.line1,
    line2: shippingAddress.line2 || '',
    locality: shippingAddress.city,
    region: shippingAddress.state,
    postal_code: shippingAddress.postalCode,
    country_code: shippingAddress.country
  }] : [];

  // Build contact payload - only include opt_in_reason if consent was given
  const contactPayload = {
    given_name: firstName,
    family_name: lastName,
    email_addresses: [{ email: email, field: 'EMAIL1' }],
    custom_fields: customFields
  };

  // Only add addresses if we have valid data
  if (addresses.length > 0) {
    contactPayload.addresses = addresses;
  }

  // Only add opt_in_reason if consent was given (don't send null)
  if (emailConsent) {
    contactPayload.opt_in_reason = 'Destiny Cards Purchase';
  }

  let contactId;

  if (isReturningCustomer) {
    // Update existing contact
    contactId = searchData.contacts[0].id;
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

  // Add repeat customer tag if applicable
  if (isReturningCustomer) {
    tags.push('Destiny Cards - Repeat Customer');
  }

  // Add product-specific tags
  for (const item of cartItems) {
    if (item.productId === 'cards-only') {
      tags.push('Destiny Cards - Cards Only');
    } else if (item.productId === 'cards-book-bundle') {
      tags.push('Destiny Cards - Cards + Book Bundle');
    }
  }

  // Add pre-order tags
  if (hasPreOrder) {
    tags.push('Destiny Cards - Pre-Order (Book Ships March 2026)');
    tags.push('Destiny Cards - Pending Book Shipment');
  }

  // Add date tag
  const orderDate = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  tags.push(`Destiny Cards - ${orderDate}`);

  // Apply each tag
  for (const tagName of tags) {
    try {
      const tagId = await getOrCreateTag(accessToken, tagName);
      await applyTagToContact(accessToken, contactId, tagId);
    } catch (tagError) {
      console.error(`Failed to apply tag "${tagName}":`, tagError);
    }
  }

  return { success: true, contactId };
}

async function getOrCreateTag(accessToken, tagName) {
  // Search for existing tag
  const searchResponse = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/tags?name=${encodeURIComponent(tagName)}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );

  if (!searchResponse.ok) {
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

  if (!response.ok) {
    throw new Error(`Tag application failed: ${response.status}`);
  }
}
