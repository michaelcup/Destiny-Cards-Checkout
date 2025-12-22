// netlify/functions/get-orders.js
// Returns all orders with fulfillment status for admin dashboard

const Stripe = require('stripe');

function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY not configured');
  }
  return new Stripe(secretKey);
}

exports.handler = async (event, context) => {
  // Handle CORS
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  // Auth check
  const authHeader = event.headers['authorization'];
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey || authHeader !== `Bearer ${adminKey}`) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  try {
    const stripe = getStripe();
    const keapToken = process.env.KEAP_ACCESS_TOKEN;

    // Fetch completed checkout sessions (most recent first)
    const sessions = await stripe.checkout.sessions.list({
      status: 'complete',
      limit: 100,
      expand: ['data.line_items', 'data.payment_intent']
    });

    // Process each session into order format
    const orders = [];

    for (const session of sessions.data) {
      // Get full session with shipping details
      const fullSession = await stripe.checkout.sessions.retrieve(session.id, {
        expand: ['shipping_details', 'line_items']
      });

      // Parse cart items from metadata
      let cartItems = [];
      let hasPreOrder = false;
      try {
        cartItems = JSON.parse(session.metadata?.cartItems || '[]');
        hasPreOrder = session.metadata?.hasPreOrder === 'true';
      } catch (e) {
        console.error('Failed to parse cart items for session:', session.id);
      }

      // Build order summary
      const orderSummary = cartItems.map(item =>
        `${item.quantity}x ${item.productName}`
      ).join(', ') || 'Unknown items';

      // Check fulfillment status from Keap if we have the token
      let cardsShipped = false;
      let bookShipped = false;
      let cardsTrackingNumber = null;
      let bookTrackingNumber = null;

      if (keapToken && fullSession.customer_details?.email) {
        try {
          const keapStatus = await getKeapFulfillmentStatus(
            keapToken,
            fullSession.customer_details.email
          );
          cardsShipped = keapStatus.cardsShipped;
          bookShipped = keapStatus.bookShipped;
          cardsTrackingNumber = keapStatus.cardsTrackingNumber;
          bookTrackingNumber = keapStatus.bookTrackingNumber;
        } catch (e) {
          console.error('Failed to get Keap status:', e.message);
        }
      }

      // Determine overall fulfillment status
      let fulfillmentStatus = 'pending';
      if (hasPreOrder) {
        if (cardsShipped && bookShipped) {
          fulfillmentStatus = 'fulfilled';
        } else if (cardsShipped) {
          fulfillmentStatus = 'partial'; // Cards shipped, book pending
        }
      } else {
        if (cardsShipped) {
          fulfillmentStatus = 'fulfilled';
        }
      }

      orders.push({
        id: session.id,
        paymentIntentId: session.payment_intent,
        created: session.created,
        createdDate: new Date(session.created * 1000).toISOString(),
        customer: {
          name: fullSession.customer_details?.name || 'Unknown',
          email: fullSession.customer_details?.email || 'Unknown'
        },
        shipping: fullSession.shipping_details ? {
          name: fullSession.shipping_details.name,
          address: {
            line1: fullSession.shipping_details.address?.line1,
            line2: fullSession.shipping_details.address?.line2,
            city: fullSession.shipping_details.address?.city,
            state: fullSession.shipping_details.address?.state,
            postalCode: fullSession.shipping_details.address?.postal_code,
            country: fullSession.shipping_details.address?.country
          }
        } : null,
        items: cartItems,
        orderSummary,
        amountTotal: session.amount_total / 100,
        hasPreOrder,
        fulfillment: {
          status: fulfillmentStatus,
          cardsShipped,
          bookShipped,
          cardsTrackingNumber,
          bookTrackingNumber
        }
      });
    }

    // Sort by created date (newest first) - already sorted by Stripe
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        orders,
        count: orders.length,
        summary: {
          total: orders.length,
          pending: orders.filter(o => o.fulfillment.status === 'pending').length,
          partial: orders.filter(o => o.fulfillment.status === 'partial').length,
          fulfilled: orders.filter(o => o.fulfillment.status === 'fulfilled').length
        }
      })
    };

  } catch (error) {
    console.error('Get orders error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to fetch orders', message: error.message })
    };
  }
};

// Helper to get fulfillment status from Keap
async function getKeapFulfillmentStatus(accessToken, email) {
  // Search for contact
  const searchResponse = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/contacts?email=${encodeURIComponent(email)}&optional_properties=custom_fields,tag_ids`,
    {
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    }
  );

  if (!searchResponse.ok) {
    throw new Error(`Keap search failed: ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json();

  if (!searchData.contacts || searchData.contacts.length === 0) {
    return { cardsShipped: false, bookShipped: false };
  }

  const contact = searchData.contacts[0];
  const customFields = contact.custom_fields || [];

  // Custom field IDs for tracking numbers
  const CARDS_TRACKING_ID = 315;
  const BOOK_TRACKING_ID = 319;

  const cardsTrackingField = customFields.find(f => f.id === CARDS_TRACKING_ID);
  const bookTrackingField = customFields.find(f => f.id === BOOK_TRACKING_ID);

  return {
    cardsShipped: !!(cardsTrackingField?.content),
    bookShipped: !!(bookTrackingField?.content),
    cardsTrackingNumber: cardsTrackingField?.content || null,
    bookTrackingNumber: bookTrackingField?.content || null
  };
}
