require('dotenv').config();

const express = require('express');
const Stripe = require('stripe');

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function logStep(step, data = {}) {
  console.log(`[${step}]`, JSON.stringify(data, null, 2));
}

function logError(step, error) {
  console.error(
    `[${step}][ERROR]`,
    JSON.stringify(
      {
        message: error.message,
        type: error.type || null,
        code: error.code || null,
        decline_code: error.decline_code || null,
        payment_intent: error.payment_intent || null,
      },
      null,
      2
    )
  );
}

/**
 * WEBHOOK STRIPE
 * Important:
 * - Doit être déclaré AVANT app.use(express.json())
 * - Utilise express.raw pour permettre la vérification de signature
 */
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const signature = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('[WEBHOOK][ERROR]', 'Missing STRIPE_WEBHOOK_SECRET');
    return res.status(500).send('Webhook secret not configured');
  }

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, webhookSecret);
  } catch (error) {
    console.error('[WEBHOOK][SIGNATURE_ERROR]', error.message);
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  logStep('WEBHOOK_RECEIVED', {
    id: event.id,
    type: event.type,
  });

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const paymentIntent = event.data.object;

        logStep('WEBHOOK_PAYMENT_INTENT_SUCCEEDED', {
          id: paymentIntent.id,
          status: paymentIntent.status,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
        });

        break;
      }

      case 'payment_intent.payment_failed': {
        const paymentIntent = event.data.object;

        logStep('WEBHOOK_PAYMENT_INTENT_FAILED', {
          id: paymentIntent.id,
          status: paymentIntent.status,
          amount: paymentIntent.amount,
          currency: paymentIntent.currency,
          last_payment_error: paymentIntent.last_payment_error
            ? paymentIntent.last_payment_error.message
            : null,
        });

        break;
      }

      case 'terminal.reader.action_failed': {
        const reader = event.data.object;

        logStep('WEBHOOK_READER_ACTION_FAILED', {
          reader_id: reader.id,
          reader_status: reader.status,
          action_type: reader.action ? reader.action.type : null,
          failure_code: reader.action ? reader.action.failure_code : null,
          failure_message: reader.action ? reader.action.failure_message : null,
          payment_intent_id:
            reader.action &&
            reader.action.process_payment_intent &&
            reader.action.process_payment_intent.payment_intent
              ? reader.action.process_payment_intent.payment_intent
              : null,
        });

        break;
      }

      default:
        logStep('WEBHOOK_UNHANDLED_EVENT', {
          type: event.type,
        });
    }

    return res.json({ received: true });
  } catch (error) {
    console.error('[WEBHOOK][HANDLER_ERROR]', error.message);
    return res.status(500).send('Webhook handler error');
  }
});

app.use(express.json());
app.use(express.static('public'));

app.post('/find-customer-by-email', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        ok: false,
        error: 'email requis'
      });
    }

    const existingCustomers = await stripe.customers.list({
      email,
      limit: 1
    });

    if (existingCustomers.data.length === 0) {
      return res.json({
        ok: true,
        found: false,
        name: ''
      });
    }

    const customer = existingCustomers.data[0];

    res.json({
      ok: true,
      found: true,
      name: customer.name || ''
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, currency, mode, email, name } = req.body;

    if (!amount || !currency || !mode) {
      return res.status(400).json({
        ok: false,
        error: 'amount, currency et mode requis'
      });
    }

    const existingCustomers = await stripe.customers.list({
  email,
  limit: 1
});

let customer;

if (existingCustomers.data.length > 0) {
  customer = existingCustomers.data[0];

  if (name && customer.name !== name) {
    customer = await stripe.customers.update(customer.id, {
      name
    });
  }
} else {
  customer = await stripe.customers.create({
    email,
    name
  });
}

    const capture_method = mode === 'preauth' ? 'manual' : 'automatic';

    const paymentIntent = await stripe.paymentIntents.create({
  amount,
  currency,
  payment_method_types: ['card_present'],
  capture_method,
  customer: customer.id,
  metadata: {
    terminal_mode: mode
  },
  receipt_email: email
});

    res.json({
      ok: true,
      payment_intent_id: paymentIntent.id,
      status: paymentIntent.status,
      capture_method: paymentIntent.capture_method,
      terminal_mode: paymentIntent.metadata.terminal_mode
    });

  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.post('/collect-payment-method', async (req, res) => {
  try {
    const { reader_id, payment_intent_id } = req.body;

    logStep('COLLECT_REQUEST', {
      reader_id,
      payment_intent_id,
    });

    const reader = await stripe.terminal.readers.processPaymentIntent(
      reader_id,
      {
        payment_intent: payment_intent_id,
      }
    );

    logStep('COLLECT_SUCCESS', {
      reader_id: reader.id,
      reader_status: reader.status,
      action_type: reader.action ? reader.action.type : null,
      action_status: reader.action ? reader.action.status : null,
      payment_intent_id,
    });

    res.json({
      ok: true,
      reader,
    });
  } catch (error) {
    logError('COLLECT', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post('/process-payment-intent', async (req, res) => {
  try {
    const { payment_intent_id } = req.body;

    logStep('PROCESS_REQUEST', {
      payment_intent_id,
    });

    const paymentIntent = await stripe.paymentIntents.retrieve(payment_intent_id);

    logStep('PROCESS_STATUS', {
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      last_payment_error: paymentIntent.last_payment_error
        ? paymentIntent.last_payment_error.message
        : null,
    });

    res.json({
      ok: true,
      payment_intent: paymentIntent,
    });
  } catch (error) {
    logError('PROCESS', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.get('/payment-intent/:id', async (req, res) => {
  try {
    const paymentIntent = await stripe.paymentIntents.retrieve(req.params.id);

    logStep('GET_PI_SUCCESS', {
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      last_payment_error: paymentIntent.last_payment_error
        ? paymentIntent.last_payment_error.message
        : null,
    });

    res.json({
      ok: true,
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      last_payment_error: paymentIntent.last_payment_error || null,
    });
  } catch (error) {
    logError('GET_PI', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post('/simulate-present-payment-method', async (req, res) => {
  try {
    const { reader_id } = req.body;

    logStep('SIMULATE_CARD_REQUEST', {
      reader_id,
    });

    const reader = await stripe.testHelpers.terminal.readers.presentPaymentMethod(
      reader_id,
      {
        type: 'card_present',
        card_present: {},
      }
    );

    logStep('SIMULATE_CARD_SUCCESS', {
      reader_id: reader.id,
      reader_status: reader.status,
      action_type: reader.action ? reader.action.type : null,
      action_status: reader.action ? reader.action.status : null,
      payment_intent_id:
        reader.action &&
        reader.action.process_payment_intent &&
        reader.action.process_payment_intent.payment_intent
          ? reader.action.process_payment_intent.payment_intent
          : null,
    });

    res.json({
      ok: true,
      reader,
    });
  } catch (error) {
    logError('SIMULATE_CARD', error);
    res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});



app.post('/capture-payment-intent', async (req, res) => {
  try {
    const { payment_intent_id, amount_to_capture } = req.body;

    if (!payment_intent_id) {
      return res.status(400).json({
        ok: false,
        error: 'payment_intent_id est obligatoire'
      });
    }

    const captureParams = {};

    if (amount_to_capture) {
      captureParams.amount_to_capture = amount_to_capture;
    }

    logStep('CAPTURE_PI_REQUEST', {
      payment_intent_id,
      amount_to_capture: amount_to_capture || null
    });

    const paymentIntent = await stripe.paymentIntents.capture(
      payment_intent_id,
      captureParams
    );

    logStep('CAPTURE_PI_SUCCESS', {
      id: paymentIntent.id,
      status: paymentIntent.status,
      amount_received: paymentIntent.amount_received,
      amount_capturable: paymentIntent.amount_capturable
    });

    res.json({
      ok: true,
      payment_intent_id: paymentIntent.id,
      status: paymentIntent.status,
      amount_received: paymentIntent.amount_received,
      amount_capturable: paymentIntent.amount_capturable
    });
  } catch (error) {
    logError('CAPTURE_PI', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});
app.post('/cancel-reader-action', async (req, res) => {
  try {
    const { reader_id, payment_intent_id } = req.body;

    if (!reader_id) {
      return res.status(400).json({
        ok: false,
        error: 'reader_id est obligatoire'
      });
    }

    logStep('CANCEL_READER_REQUEST', {
      reader_id,
      payment_intent_id: payment_intent_id || null
    });

    const reader = await stripe.terminal.readers.cancelAction(reader_id);

    let canceledPaymentIntent = null;

    if (payment_intent_id) {
      try {
        canceledPaymentIntent = await stripe.paymentIntents.cancel(payment_intent_id);

        logStep('CANCEL_PI_SUCCESS', {
          id: canceledPaymentIntent.id,
          status: canceledPaymentIntent.status
        });
      } catch (error) {
        logError('CANCEL_PI', error);
      }
    }

    logStep('CANCEL_READER_SUCCESS', {
      reader_id: reader.id,
      reader_status: reader.status,
      action: reader.action || null
    });

    res.json({
      ok: true,
      reader,
      payment_intent: canceledPaymentIntent
    });
  } catch (error) {
    logError('CANCEL_READER', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  logStep('SERVER_STARTED', {
    port: process.env.PORT || 3000,
  });
});
