// netlify/functions/process-destiny-cards-payment.js
// Processes Stripe payments for Destiny Cards and integrates with Keap

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

exports.handler = async (event, context) => {
  // Only allow POST requests
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  try {
    const { 
      paymentMethodId, 
      amount, 
      customerData,
      billingData
    } = JSON.parse(event.body);

    // Create payment intent
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100, // Stripe uses cents
      currency: 'usd',
      payment_method: paymentMethodId,
      confirm: true,
      description: `Destiny Cards Order - ${customerData.productName} - ${customerData.firstName} ${customerData.lastName}`,
      receipt_email: customerData.email,
      shipping: {
        name: `${customerData.firstName} ${customerData.lastName}`,
        address: {
          line1: customerData.shippingAddress.line1,
          line2: customerData.shippingAddress.line2,
          city: customerData.shippingAddress.city,
          state: customerData.shippingAddress.state,
          postal_code: customerData.shippingAddress.postalCode,
          country: customerData.shippingAddress.country,
        }
      },
      return_url: 'https://destinycards.paradoxprocess.org',
    });

    // Check if payment succeeded
    if (paymentIntent.status === 'succeeded') {
      // Payment successful! Now integrate with Keap
      try {
        const keapResult = await integrateWithKeap({
          ...customerData,
          paymentId: paymentIntent.id,
          paymentStatus: 'succeeded',
          amountPaid: amount,
        });

        if (keapResult.success) {
          return {
            statusCode: 200,
            headers: {
              'Access-Control-Allow-Origin': '*',
              'Access-Control-Allow-Headers': 'Content-Type',
            },
            body: JSON.stringify({
              success: true,
              message: 'Payment successful and order confirmed!',
              paymentId: paymentIntent.id,
              contactId: keapResult.contactId,
            }),
          };
        } else {
          throw new Error(keapResult.message || 'Keap integration failed');
        }
      } catch (keapError) {
        console.error('Keap integration error:', keapError);
        return {
          statusCode: 500,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Content-Type',
          },
          body: JSON.stringify({
            success: false,
            message: 'Payment processed but order registration failed. Please contact support.',
            paymentId: paymentIntent.id,
            error: keapError.message,
          }),
        };
      }
    } else {
      return {
        statusCode: 400,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
        body: JSON.stringify({
          success: false,
          message: 'Payment failed. Please try again.',
          error: paymentIntent.last_payment_error?.message || 'Unknown error',
        }),
      };
    }

  } catch (error) {
    console.error('Payment processing error:', error);
    
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: JSON.stringify({
        success: false,
        message: 'An error occurred processing your payment.',
        error: error.message,
      }),
    };
  }
};

// Keap integration function
async function integrateWithKeap(data) {
  try {
    console.log('Received data in integrateWithKeap:', JSON.stringify(data, null, 2));
    
    const {
      firstName,
      lastName,
      email,
      emailConsent,
      product,
      productName,
      productPrice,
      shippingAddress,
      paymentId,
      amountPaid
    } = data;

    const accessToken = process.env.KEAP_ACCESS_TOKEN;
    
    console.log('Environment check:');
    console.log('Has KEAP_ACCESS_TOKEN:', !!accessToken);
    
    if (!accessToken) {
      throw new Error('Keap Personal Access Token not configured');
    }
    
    if (!accessToken.startsWith('KeapAK-')) {
      throw new Error('Keap token appears to be malformed - should start with KeapAK-');
    }

    // Format shipping address for Keap
    const shippingAddressFormatted = `${shippingAddress.line1}${shippingAddress.line2 ? '\n' + shippingAddress.line2 : ''}\n${shippingAddress.city}, ${shippingAddress.state} ${shippingAddress.postalCode}\n${shippingAddress.country}`;

    // Create or update contact
    const contact = await createOrUpdateContact(accessToken, {
      firstName,
      lastName,
      email,
      emailConsent,
      product,
      productName,
      productPrice,
      shippingAddressFormatted,
      paymentId
    });

    // Create tags for this order
    const tagIds = await createOrderTags(accessToken, product, paymentId);

    // Apply tags to contact
    await applyTagsToContact(accessToken, contact.id, tagIds);

    return {
      success: true,
      message: 'Contact created and order processed successfully',
      contactId: contact.id,
      tagsCreated: tagIds.length
    };

  } catch (error) {
    console.error('Keap integration error:', error);
    return {
      success: false,
      message: 'Failed to process Keap integration',
      error: error.message,
    };
  }
}

async function createOrUpdateContact(accessToken, contactData) {
  const {
    firstName,
    lastName,
    email,
    emailConsent,
    product,
    productName,
    productPrice,
    shippingAddressFormatted,
    paymentId
  } = contactData;

  console.log('Creating/updating contact for:', email);

  // Search for existing contact
  const searchResponse = await fetch(`https://api.infusionsoft.com/crm/rest/v1/contacts?email=${encodeURIComponent(email)}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!searchResponse.ok) {
    throw new Error(`Failed to search for contact: ${searchResponse.status} ${searchResponse.statusText}`);
  }

  const searchData = await searchResponse.json();
  console.log('Contact search result:', searchData);

  let contact;

  // Custom field IDs for Destiny Cards (you'll need to create these in Keap)
  // These are placeholders - replace with actual IDs from your Keap instance
  const CUSTOM_FIELDS = {
    PRODUCT_ORDERED: 291,      // Text field: which product (cards-only or cards-book)
    PRODUCT_NAME: 293,          // Text field: full product name
    PRODUCT_PRICE: 295,         // Number field: price paid
    SHIPPING_ADDRESS: 297,      // Text Area field: full shipping address
    PAYMENT_ID: 299,            // Text field: Stripe payment ID
    ORDER_DATE: 301             // Date field: when order was placed
  };

  if (searchData.contacts && searchData.contacts.length > 0) {
    // Update existing contact
    const contactId = searchData.contacts[0].id;
    console.log('Updating existing contact:', contactId);
    
    const updatePayload = {
      given_name: firstName,
      family_name: lastName,
      email_addresses: [{ email: email, field: 'EMAIL1' }],
      opt_in_reason: emailConsent ? 'Destiny Cards Purchase' : null,
      custom_fields: [
        { id: CUSTOM_FIELDS.PRODUCT_ORDERED, content: product },
        { id: CUSTOM_FIELDS.PRODUCT_NAME, content: productName },
        { id: CUSTOM_FIELDS.PRODUCT_PRICE, content: productPrice.toString() },
        { id: CUSTOM_FIELDS.SHIPPING_ADDRESS, content: shippingAddressFormatted },
        { id: CUSTOM_FIELDS.PAYMENT_ID, content: paymentId },
        { id: CUSTOM_FIELDS.ORDER_DATE, content: new Date().toISOString().split('T')[0] }
      ]
    };

    console.log('Update payload:', JSON.stringify(updatePayload, null, 2));

    const updateResponse = await fetch(`https://api.infusionsoft.com/crm/rest/v1/contacts/${contactId}`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updatePayload),
    });

    console.log('Update response status:', updateResponse.status);

    if (!updateResponse.ok) {
      const errorText = await updateResponse.text();
      console.error('Update failed:', errorText);
      throw new Error(`Failed to update contact: ${updateResponse.status} ${errorText}`);
    }

    contact = await updateResponse.json();
    contact.id = contactId;
    console.log('Contact updated successfully:', contact.id);
  } else {
    // Create new contact
    console.log('Creating new contact');
    
    const createPayload = {
      given_name: firstName,
      family_name: lastName,
      email_addresses: [{ email: email, field: 'EMAIL1' }],
      opt_in_reason: emailConsent ? 'Destiny Cards Purchase' : null,
      custom_fields: [
        { id: CUSTOM_FIELDS.PRODUCT_ORDERED, content: product },
        { id: CUSTOM_FIELDS.PRODUCT_NAME, content: productName },
        { id: CUSTOM_FIELDS.PRODUCT_PRICE, content: productPrice.toString() },
        { id: CUSTOM_FIELDS.SHIPPING_ADDRESS, content: shippingAddressFormatted },
        { id: CUSTOM_FIELDS.PAYMENT_ID, content: paymentId },
        { id: CUSTOM_FIELDS.ORDER_DATE, content: new Date().toISOString().split('T')[0] }
      ]
    };

    console.log('Create payload:', JSON.stringify(createPayload, null, 2));

    const createResponse = await fetch('https://api.infusionsoft.com/crm/rest/v1/contacts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createPayload),
    });

    console.log('Create response status:', createResponse.status);

    if (!createResponse.ok) {
      const errorText = await createResponse.text();
      console.error('Create failed:', errorText);
      throw new Error(`Failed to create contact: ${createResponse.status} ${errorText}`);
    }

    contact = await createResponse.json();
    console.log('Contact created successfully:', contact.id);
  }

  return contact;
}

// Create tags for order tracking and automation
async function createOrderTags(accessToken, product, paymentId) {
  console.log('Creating order tags for product:', product);
  
  const tagIds = [];

  // Main trigger tag for Keap automation
  console.log('Creating main trigger tag');
  const mainTag = await createTag(accessToken, 'Destiny Cards - Order Received');
  tagIds.push(mainTag.id);
  console.log('Main trigger tag created:', mainTag.id);

  // Product-specific tag
  const productTagName = product === 'cards-only' 
    ? 'Destiny Cards - Cards Only' 
    : 'Destiny Cards - Cards + Book';
  console.log('Creating product tag:', productTagName);
  const productTag = await createTag(accessToken, productTagName);
  tagIds.push(productTag.id);
  console.log('Product tag created:', productTag.id);

  // Payment reference tag
  console.log('Creating payment reference tag');
  const paymentTag = await createTag(accessToken, `DC Payment - ${paymentId.slice(-8)}`);
  tagIds.push(paymentTag.id);
  console.log('Payment tag created:', paymentTag.id);

  // Date-based tag for reporting
  const orderDate = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  console.log('Creating date tag:', orderDate);
  const dateTag = await createTag(accessToken, `Destiny Cards - ${orderDate}`);
  tagIds.push(dateTag.id);
  console.log('Date tag created:', dateTag.id);

  // 1st Edition tag
  console.log('Creating edition tag');
  const editionTag = await createTag(accessToken, 'Destiny Cards - 1st Edition');
  tagIds.push(editionTag.id);
  console.log('Edition tag created:', editionTag.id);

  console.log('All tags created. Total:', tagIds.length);
  return tagIds;
}

// Create a single tag in Keap (or get existing one)
async function createTag(accessToken, tagName) {
  console.log('Creating/finding tag:', tagName);
  
  // Check if tag already exists
  const searchResponse = await fetch(`https://api.infusionsoft.com/crm/rest/v1/tags?name=${encodeURIComponent(tagName)}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!searchResponse.ok) {
    throw new Error(`Failed to search for tag "${tagName}": ${searchResponse.status}`);
  }

  const searchData = await searchResponse.json();
  console.log(`Tag search result for "${tagName}":`, searchData);
  
  if (searchData.tags && searchData.tags.length > 0) {
    console.log(`Tag "${tagName}" already exists with ID:`, searchData.tags[0].id);
    return searchData.tags[0];
  }

  // Create new tag
  console.log(`Creating new tag: "${tagName}"`);
  const createResponse = await fetch('https://api.infusionsoft.com/crm/rest/v1/tags', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: tagName,
      description: `Auto-created tag for Destiny Cards - ${new Date().toISOString()}`
    }),
  });

  console.log(`Tag creation response status: ${createResponse.status}`);

  if (!createResponse.ok) {
    const errorText = await createResponse.text();
    console.error(`Tag creation failed:`, errorText);
    throw new Error(`Failed to create tag "${tagName}": ${createResponse.status} ${errorText}`);
  }

  const newTag = await createResponse.json();
  console.log(`Tag "${tagName}" created successfully with ID:`, newTag.id);
  return newTag;
}

// Apply tags to a contact
async function applyTagsToContact(accessToken, contactId, tagIds) {
  console.log(`Applying ${tagIds.length} tags to contact ${contactId}`);
  
  const results = [];
  for (const tagId of tagIds) {
    try {
      console.log(`Applying tag ${tagId} to contact ${contactId}`);
      
      const response = await fetch(`https://api.infusionsoft.com/crm/rest/v1/contacts/${contactId}/tags`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tagIds: [tagId]
        }),
      });

      console.log(`Tag application response: ${response.status}`);
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Failed to apply tag ${tagId}:`, errorText);
        throw new Error(`Failed to apply tag ${tagId}: ${response.status} ${errorText}`);
      }
      
      results.push({ tagId, success: true });
    } catch (error) {
      console.error(`Error applying tag ${tagId}:`, error);
      results.push({ tagId, success: false, error: error.message });
      throw error;
    }
  }
  
  console.log('All tags applied successfully:', results);
  return results;
}