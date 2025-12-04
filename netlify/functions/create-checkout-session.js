// netlify/functions/create-checkout-session.js
// Creates a Stripe Checkout Session for embedded checkout

const Stripe = require('stripe');

// Initialize Stripe lazily to ensure env vars are loaded
function getStripe() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    throw new Error('STRIPE_SECRET_KEY environment variable is not set. Please add it in Netlify Dashboard → Site Settings → Environment Variables');
  }
  return new Stripe(secretKey);
}

// Product configuration - matches frontend
const PRODUCTS = {
  'cards-only': {
    name: 'Destiny Cards - 1st Edition',
    description: 'Complete 1st Edition Destiny Cards deck with 25+ Functional Philosophy cards, 10+ Resourceful State cards, and quick-start guide.',
    price: 2000, // in cents
    shipsNow: true
  },
  'cards-book-bundle': {
    name: 'Destiny Cards + Rules To Live By Pre-Order Bundle',
    description: 'Destiny Cards deck (ships now) + "Rules To Live By (But Not Believe)" book pre-order (ships March 2025). Items ship separately.',
    price: 6000, // in cents
    shipsNow: false,
    splitShipment: true
  }
};

// Shipping rates - define these in Stripe Dashboard for more control
// These are created programmatically as fallback
const SHIPPING_RATES = {
  us_standard: {
    display_name: 'Standard Shipping (US)',
    amount: 500, // $5
    min_days: 5,
    max_days: 7
  },
  us_express: {
    display_name: 'Express Shipping (US)',
    amount: 1200, // $12
    min_days: 2,
    max_days: 3
  },
  international: {
    display_name: 'International Shipping',
    amount: 1500, // $15
    min_days: 10,
    max_days: 21
  }
};

exports.handler = async (event, context) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const stripe = getStripe();
    const { cartItems, customerEmail, emailConsent } = JSON.parse(event.body);

    if (!cartItems || cartItems.length === 0) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'Cart is empty' })
      };
    }

    // Build line items for Stripe
    const lineItems = cartItems.map(item => {
      const product = PRODUCTS[item.productId];
      if (!product) {
        throw new Error(`Unknown product: ${item.productId}`);
      }

      return {
        price_data: {
          currency: 'usd',
          product_data: {
            name: product.name,
            description: product.description,
            metadata: {
              productId: item.productId,
              shipsNow: product.shipsNow.toString(),
              splitShipment: (product.splitShipment || false).toString()
            }
          },
          unit_amount: product.price
        },
        quantity: item.quantity
      };
    });

    // Check if order includes pre-orders
    const hasPreOrder = cartItems.some(item => PRODUCTS[item.productId]?.splitShipment);

    // Get or create shipping rates
    const shippingOptions = await getOrCreateShippingRates(stripe);

    // Create the checkout session
    const session = await stripe.checkout.sessions.create({
      ui_mode: 'embedded',
      mode: 'payment',
      line_items: lineItems,
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'NZ', 'IE', 'DE', 'FR', 'NL', 'BE']
      },
      shipping_options: shippingOptions,
      customer_email: customerEmail || undefined,
      custom_text: {
        shipping_address: {
          message: hasPreOrder
            ? 'Note: Your Destiny Cards will ship immediately. The book pre-order will ship separately in March 2025.'
            : 'Your Destiny Cards will ship within 3-5 business days.'
        },
        submit: {
          message: 'Your payment is secured by Stripe.'
        }
      },
      metadata: {
        hasPreOrder: hasPreOrder.toString(),
        emailConsent: (emailConsent || false).toString(),
        cartItems: JSON.stringify(cartItems)
      },
      return_url: `${process.env.URL || 'https://destinycards.paradoxprocess.org'}/checkout-complete?session_id={CHECKOUT_SESSION_ID}`
    });

    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: JSON.stringify({
        clientSecret: session.client_secret,
        sessionId: session.id
      })
    };

  } catch (error) {
    console.error('Checkout session error:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        error: 'Failed to create checkout session',
        message: error.message
      })
    };
  }
};

// Get existing shipping rates or create them
async function getOrCreateShippingRates(stripe) {
  try {
    // Try to fetch existing shipping rates
    const existingRates = await stripe.shippingRates.list({ active: true, limit: 10 });

    // Look for our rates by display name
    const usStandard = existingRates.data.find(r => r.display_name === SHIPPING_RATES.us_standard.display_name);
    const usExpress = existingRates.data.find(r => r.display_name === SHIPPING_RATES.us_express.display_name);
    const international = existingRates.data.find(r => r.display_name === SHIPPING_RATES.international.display_name);

    const shippingOptions = [];

    // Use existing or create new rates
    if (usStandard) {
      shippingOptions.push({ shipping_rate: usStandard.id });
    } else {
      const newRate = await stripe.shippingRates.create({
        display_name: SHIPPING_RATES.us_standard.display_name,
        type: 'fixed_amount',
        fixed_amount: { amount: SHIPPING_RATES.us_standard.amount, currency: 'usd' },
        delivery_estimate: {
          minimum: { unit: 'business_day', value: SHIPPING_RATES.us_standard.min_days },
          maximum: { unit: 'business_day', value: SHIPPING_RATES.us_standard.max_days }
        }
      });
      shippingOptions.push({ shipping_rate: newRate.id });
    }

    if (usExpress) {
      shippingOptions.push({ shipping_rate: usExpress.id });
    } else {
      const newRate = await stripe.shippingRates.create({
        display_name: SHIPPING_RATES.us_express.display_name,
        type: 'fixed_amount',
        fixed_amount: { amount: SHIPPING_RATES.us_express.amount, currency: 'usd' },
        delivery_estimate: {
          minimum: { unit: 'business_day', value: SHIPPING_RATES.us_express.min_days },
          maximum: { unit: 'business_day', value: SHIPPING_RATES.us_express.max_days }
        }
      });
      shippingOptions.push({ shipping_rate: newRate.id });
    }

    if (international) {
      shippingOptions.push({ shipping_rate: international.id });
    } else {
      const newRate = await stripe.shippingRates.create({
        display_name: SHIPPING_RATES.international.display_name,
        type: 'fixed_amount',
        fixed_amount: { amount: SHIPPING_RATES.international.amount, currency: 'usd' },
        delivery_estimate: {
          minimum: { unit: 'business_day', value: SHIPPING_RATES.international.min_days },
          maximum: { unit: 'business_day', value: SHIPPING_RATES.international.max_days }
        }
      });
      shippingOptions.push({ shipping_rate: newRate.id });
    }

    return shippingOptions;

  } catch (error) {
    console.error('Error with shipping rates:', error);
    // Return empty array - Stripe will still work, just without shipping options
    return [];
  }
}
