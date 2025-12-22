// netlify/functions/get-inventory.js
// Returns current inventory levels based on Stripe sales

const Stripe = require('stripe');

const TOTAL_INVENTORY = 75;

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
    'Access-Control-Allow-Headers': 'Content-Type',
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

  try {
    const stripe = getStripe();

    // Fetch all completed checkout sessions
    // We'll paginate through all of them to get accurate count
    let totalCardsSold = 0;
    let hasMore = true;
    let startingAfter = null;

    while (hasMore) {
      const params = {
        status: 'complete',
        limit: 100,
        expand: ['data.line_items']
      };

      if (startingAfter) {
        params.starting_after = startingAfter;
      }

      const sessions = await stripe.checkout.sessions.list(params);

      for (const session of sessions.data) {
        // Parse cart items from metadata to count cards
        try {
          const cartItems = JSON.parse(session.metadata?.cartItems || '[]');
          for (const item of cartItems) {
            // Both products include cards, so count all quantities
            totalCardsSold += item.quantity || 0;
          }
        } catch (e) {
          // If we can't parse metadata, try to count from line items
          if (session.line_items?.data) {
            for (const lineItem of session.line_items.data) {
              totalCardsSold += lineItem.quantity || 0;
            }
          }
        }
      }

      hasMore = sessions.has_more;
      if (sessions.data.length > 0) {
        startingAfter = sessions.data[sessions.data.length - 1].id;
      } else {
        hasMore = false;
      }
    }

    const remaining = Math.max(0, TOTAL_INVENTORY - totalCardsSold);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        total: TOTAL_INVENTORY,
        sold: totalCardsSold,
        remaining: remaining,
        percentSold: Math.round((totalCardsSold / TOTAL_INVENTORY) * 100)
      })
    };

  } catch (error) {
    console.error('Inventory check error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Failed to check inventory' })
    };
  }
};
