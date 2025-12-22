// netlify/functions/check-fulfillment.js
// Checks fulfillment status for a single order from Keap

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // Auth check
  const authHeader = event.headers['authorization'];
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey || authHeader !== `Bearer ${adminKey}`) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const email = event.queryStringParameters?.email;
  if (!email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email parameter required' }) };
  }

  const keapToken = process.env.KEAP_ACCESS_TOKEN;
  if (!keapToken) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Keap not configured' }) };
  }

  try {
    // Search for contact in Keap
    const searchResponse = await fetch(
      `https://api.infusionsoft.com/crm/rest/v1/contacts?email=${encodeURIComponent(email)}&optional_properties=custom_fields`,
      {
        headers: {
          'Authorization': `Bearer ${keapToken}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!searchResponse.ok) {
      if (searchResponse.status === 429) {
        return {
          statusCode: 429,
          headers,
          body: JSON.stringify({ error: 'Rate limited. Please wait a moment.' })
        };
      }
      throw new Error(`Keap search failed: ${searchResponse.status}`);
    }

    const searchData = await searchResponse.json();

    if (!searchData.contacts || searchData.contacts.length === 0) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          found: false,
          cardsShipped: false,
          bookShipped: false
        })
      };
    }

    const contact = searchData.contacts[0];
    const customFields = contact.custom_fields || [];

    // Custom field IDs for tracking numbers
    const CARDS_TRACKING_ID = 315;
    const BOOK_TRACKING_ID = 319;

    const cardsTrackingField = customFields.find(f => f.id === CARDS_TRACKING_ID);
    const bookTrackingField = customFields.find(f => f.id === BOOK_TRACKING_ID);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: true,
        cardsShipped: !!(cardsTrackingField?.content),
        bookShipped: !!(bookTrackingField?.content),
        cardsTrackingNumber: cardsTrackingField?.content || null,
        bookTrackingNumber: bookTrackingField?.content || null
      })
    };

  } catch (error) {
    console.error('Check fulfillment error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};
