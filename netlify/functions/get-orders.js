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

  if (!adminKey) {
    console.error('ADMIN_API_KEY environment variable is not set');
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Server configuration error: ADMIN_API_KEY not set' })
    };
  }

  if (authHeader !== `Bearer ${adminKey}`) {
    return {
      statusCode: 401,
      headers,
      body: JSON.stringify({ error: 'Invalid API key' })
    };
  }

  try {
    const stripe = getStripe();

    console.log('Fetching checkout sessions from Stripe...');

    // Fetch completed checkout sessions (most recent first)
    const sessions = await stripe.checkout.sessions.list({
      status: 'complete',
      limit: 100
    });

    console.log(`Found ${sessions.data.length} sessions`);

    // Process each session into order format
    const orders = [];

    for (const session of sessions.data) {
      try {
        // Get full session with shipping details
        const fullSession = await stripe.checkout.sessions.retrieve(session.id);

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

        // Initialize fulfillment status (will be checked separately to avoid rate limits)
        let cardsShipped = false;
        let bookShipped = false;
        let cardsTrackingNumber = null;
        let bookTrackingNumber = null;

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
      } catch (sessionError) {
        console.error(`Error processing session ${session.id}:`, sessionError.message);
        // Continue with next session
      }
    }

    console.log(`Processed ${orders.length} orders successfully`);

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
      body: JSON.stringify({
        error: 'Failed to fetch orders',
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
      })
    };
  }
};
