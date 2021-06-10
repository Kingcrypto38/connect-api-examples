/*
Copyright 2021 Square Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const locationId = process.env[`SQUARE_LOCATION_ID`];
const {
  giftCardsApi,
  giftCardActivitiesApi,
  customersApi,
  ordersApi,
  paymentsApi,
} = require("../util/square-client");
const { capitalize, getImageForBrand } = require("../util/card-on-file");

const { checkLoginStatus, checkCardOwner } = require("../util/middleware");

/**
 * GET /gift-card/:gan
 *
 * Shows the details of a gift card by its GAN
 */
router.get("/:gan", checkLoginStatus, checkCardOwner, async (req, res, next) => {
  const giftCard = res.locals.giftCard;
  const payment = req.query.payment;

  res.render("pages/card-detail", { giftCard, payment });
});

/**
 * GET /gift-card/:gan/history
 * 
 * Displays the transaction history for a card
 */
 router.get("/:gan/history", checkLoginStatus, checkCardOwner, async (req, res, next) => {
  try {
    const giftCard = res.locals.giftCard;
    const { result : { giftCardActivities } } = await giftCardActivitiesApi.listGiftCardActivities(giftCard.id);

    res.render("pages/history", { giftCard, giftCardActivities });
  } catch (error) {
    console.error(error);
    next(error);
  }
});

/**
 * POST /gift-card/create
 *
 * Creates a gift card for the logged in customer.
 * It will create an inactive gift card with 0 balance,
 * and link it to the logged in customer.
 */
router.post("/create", checkLoginStatus, async (req, res, next) => {
  try {
    // The following information will come from the request/session.
    const customerId = req.session.customerId;

    // Create an inactive gift card.
    const giftCardRequest = generateGiftCardRequest();
    const { result: { giftCard }} = await giftCardsApi.createGiftCard(giftCardRequest);

    // Now link it to the customer logged in!
    await giftCardsApi.linkCustomerToGiftCard(giftCard.id, {
      customerId
    });

    // Redirect to GET /gift-card/:gan, which will render the card-detail page.
    res.redirect("/gift-card/" + giftCard.gan);
  } catch (error) {
    console.error(error);
    next(error);
  }
});

/**
 * GET /gift-card/:gan/add-funds
 *
 * Renders the `add funds` page.
 * This endpoint retrieves all cards on file for the customer currently logged in.
 * You can add additional logic to filter out payment methods that might not be allowed
 * (i.e. loading gift cards using an existing gift card).
 */
 router.get("/:gan/add-funds", checkLoginStatus, checkCardOwner, async (req, res, next) => {
  try {
    const { result: { customer } } = await customersApi.retrieveCustomer(req.session.customerId);
    const cards = customer.cards.filter(card => card.cardBrand !== "SQUARE_GIFT_CARD");

    const cardsData = cards.map((card) => {
      return {
        img: getImageForBrand(card.cardBrand),
        value: card.id,
        displayValue: capitalize(card.cardBrand) + " ●●●● " + card.last4,
        description: capitalize(card.cardBrand)
      }
    })

    res.render("pages/add-funds", { cards, cardsData, giftCard: res.locals.giftCard });
  } catch (error) {
    console.error(error);
    next(error);
  }
});

/**
 * POST /gift-card/:gan/add-funds
 *
 * Adds funds by loading or activating a given gift card with the amount provided.
 * Steps are:
 * 1. Create an order (with the amount provided by the customer)
 * 2. Create a payment using the orderId and sourceId from (1)
 * 3. Load or activate the gift card using information from (1,2)
 */
router.post("/:gan/add-funds", checkLoginStatus, checkCardOwner, async (req, res, next) => {
  try {
    // The following information will come from the request/session.
    const customerId = req.session.customerId;
    const amount = req.body.amount;
    const paymentSource = req.body.cardId;
    const giftCardState = req.body.state;
    const gan = req.params.gan;

    // Get the currency to be used for the order/payment.
    const currency = req.app.locals.currency;

    // The following code runs the order/payment flow.
    // Await order call, as payment needs order information.
    const orderRequest = generateOrderRequest(customerId, amount, currency);
    const { result: { order } } = await ordersApi.createOrder(orderRequest);

    // Extract useful information from the order.
    const orderId = order.id;
    const lineItemId = order.lineItems[0].uid;

    // We have the order response, we can move on to the payment.
    const paymentRequest = generatePaymentRequest(customerId, amount, currency, paymentSource, orderId);
    await paymentsApi.createPayment(paymentRequest);

    // Load or activate the gift card based on its current state.
    // If the gift card is inactive, activate it with the amount given.
    // Otherwise, if the card is already active, load it with the amount given.
    const giftCardActivity = giftCardState === "NOT_ACTIVE" ? "ACTIVATE" : "LOAD";
    const giftCardActivityRequest = generateGiftCardActivityRequest(giftCardActivity, gan, orderId, lineItemId);
    await giftCardActivitiesApi.createGiftCardActivity(giftCardActivityRequest);

    // Redirect to GET /gift-card/:gan, which will render the card-detail page, with a success message.
    res.redirect("/gift-card/" + gan + "/?payment=success");
  } catch (error) {
    console.error(error);
    next(error);
  }
});

/**
 * Helper function for generating a gift card order request.
 * This function builds the request that will be used in the POST "v2/orders" API call.
 */
function generateOrderRequest(customerId, amount, currency) {
  return {
    idempotencyKey: uuidv4(),
    order: {
      lineItems: [
        {
          name: "A cool gift card",
          quantity: "1",
          itemType: "GIFT_CARD",
          basePriceMoney: {
            amount: amount,
            currency: currency
          }
        }
      ],
      locationId: locationId,
      customerId: customerId
    }
  };
}

/**
 * Helper function for generating a gift card payment request.
 * This function builds the request that will be used in the POST "v2/payment" API call.
 */
function generatePaymentRequest(customerId, amount, currency, paymentSource, orderId) {
  return {
    idempotencyKey: uuidv4(),
    sourceId: paymentSource,
    amountMoney: {
      amount: amount,
      currency: currency
    },
    orderId: orderId,
    locationId: locationId,
    customerId: customerId
  };
}

/**
 * Helper function for generating a create gift card request.
 * This function builds the request that will be used in the POST "v2/gift-cards" API call.
 */
function generateGiftCardRequest() {
  return {
    idempotencyKey: uuidv4(),
    locationId: locationId,
    giftCard: {
      type: "DIGITAL"
    }
  };
}

/**
 * Helper function for generating a create gift card activity request.
 * This function builds the request that will be used in the POST "v2/gift-cards/activities" API call.
 */
 function generateGiftCardActivityRequest(activityName, gan, orderId, lineItemId) {
  const activityObject = getActivityObject(activityName, orderId, lineItemId);
  const [ key ] = Object.keys(activityObject);
  const [ value ] = Object.values(activityObject);
  const request = {
    idempotencyKey: uuidv4(),
    giftCardActivity: {
      giftCardGan: gan,
      type: activityName,
      locationId: locationId,
    }
  };
  // Add the correct activity object to our request.
  request.giftCardActivity[key] = value;
  return request;
}

/**
 * Helper function for getting the correct "Activity Object" for the
 * POST "v2/gift-cards/activities" request, based on the activity needed.
 * Currently, this app supports two activities: ACTIVATE (activating an inactive/new gift card),
 * and LOAD (loading an existing gift card).
 * This functionality can be extended to other activities as well.
 */
function getActivityObject(activityName, orderId, lineItemId) {
  switch(activityName) {
    case "ACTIVATE":
      return {
        activateActivityDetails: {
          orderId: orderId,
          lineItemUid: lineItemId
        }
      };
    case "LOAD":
      return {
        loadActivityDetails: {
          orderId: orderId,
          lineItemUid: lineItemId
        }
      };
    // Add more Gift Card Activities types you wish to support here!
    default:
      console.error("Unrecognized type");
  }
}

module.exports = router;
