// netlify/functions/update-tracking.js
// Updates tracking numbers in Keap and triggers shipping notification

exports.handler = async (event, context) => {
  // Handle CORS
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS'
      },
      body: ''
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  // Simple auth check - use a secret key
  const authHeader = event.headers['authorization'];
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey || authHeader !== `Bearer ${adminKey}`) {
    return {
      statusCode: 401,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: 'Unauthorized' })
    };
  }

  try {
    const { email, trackingNumber, shipmentType } = JSON.parse(event.body);

    if (!email || !trackingNumber || !shipmentType) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({
          error: 'Missing required fields: email, trackingNumber, shipmentType (cards or book)'
        })
      };
    }

    if (!['cards', 'book'].includes(shipmentType)) {
      return {
        statusCode: 400,
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify({ error: 'shipmentType must be "cards" or "book"' })
      };
    }

    const result = await updateTrackingInKeap(email, trackingNumber, shipmentType);

    return {
      statusCode: 200,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({
        success: true,
        message: `Tracking number updated for ${email}`,
        contactId: result.contactId
      })
    };

  } catch (error) {
    console.error('Update tracking error:', error);
    return {
      statusCode: 500,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: error.message })
    };
  }
};

async function updateTrackingInKeap(email, trackingNumber, shipmentType) {
  const accessToken = process.env.KEAP_ACCESS_TOKEN;

  if (!accessToken) {
    throw new Error('KEAP_ACCESS_TOKEN not configured');
  }

  // Custom field IDs - must match your Keap setup
  const CUSTOM_FIELDS = {
    CARDS_TRACKING_NUMBER: 315,
    CARDS_SHIPPED_DATE: 317,
    BOOK_TRACKING_NUMBER: 319,
    BOOK_SHIPPED_DATE: 321
  };

  // Find contact by email
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

  if (!searchData.contacts || searchData.contacts.length === 0) {
    throw new Error(`No contact found with email: ${email}`);
  }

  const contactId = searchData.contacts[0].id;
  const today = new Date().toISOString().split('T')[0];

  // Determine which fields to update based on shipment type
  const customFields = shipmentType === 'cards'
    ? [
        { id: CUSTOM_FIELDS.CARDS_TRACKING_NUMBER, content: trackingNumber },
        { id: CUSTOM_FIELDS.CARDS_SHIPPED_DATE, content: today }
      ]
    : [
        { id: CUSTOM_FIELDS.BOOK_TRACKING_NUMBER, content: trackingNumber },
        { id: CUSTOM_FIELDS.BOOK_SHIPPED_DATE, content: today }
      ];

  // Update contact with tracking info
  const updateResponse = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/contacts/${contactId}`,
    {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ custom_fields: customFields })
    }
  );

  if (!updateResponse.ok) {
    throw new Error(`Contact update failed: ${updateResponse.status}`);
  }

  // Apply shipped tag and remove awaiting shipment tag
  const shippedTagName = shipmentType === 'cards'
    ? 'Destiny Cards - Cards Shipped'
    : 'Destiny Cards - Book Shipped';

  const awaitingTagName = shipmentType === 'cards'
    ? 'Destiny Cards - Awaiting Shipment'
    : 'Destiny Cards - Pending Book Shipment';

  // Apply shipped tag
  try {
    const shippedTagId = await getOrCreateTag(accessToken, shippedTagName);
    await applyTagToContact(accessToken, contactId, shippedTagId);
  } catch (e) {
    console.error('Failed to apply shipped tag:', e);
  }

  // Remove awaiting tag
  try {
    const awaitingTagId = await getTagId(accessToken, awaitingTagName);
    if (awaitingTagId) {
      await removeTagFromContact(accessToken, contactId, awaitingTagId);
    }
  } catch (e) {
    console.error('Failed to remove awaiting tag:', e);
  }

  return { contactId };
}

async function getOrCreateTag(accessToken, tagName) {
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
        description: `Auto-created for Destiny Cards shipping`
      })
    }
  );

  if (!createResponse.ok) {
    throw new Error(`Tag creation failed: ${createResponse.status}`);
  }

  const newTag = await createResponse.json();
  return newTag.id;
}

async function getTagId(accessToken, tagName) {
  const searchResponse = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/tags?name=${encodeURIComponent(tagName)}`,
    {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    }
  );

  if (!searchResponse.ok) return null;

  const searchData = await searchResponse.json();
  return searchData.tags?.[0]?.id || null;
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

async function removeTagFromContact(accessToken, contactId, tagId) {
  const response = await fetch(
    `https://api.infusionsoft.com/crm/rest/v1/contacts/${contactId}/tags/${tagId}`,
    {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    }
  );

  // 404 is ok - tag wasn't applied
  if (!response.ok && response.status !== 404) {
    throw new Error(`Tag removal failed: ${response.status}`);
  }
}
