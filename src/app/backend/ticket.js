import { adminDb } from "./firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";

/**
 * Ticket Generation Route
 * Handles ticket creation after payment verification
 * Supports multi-ticket purchases and guest checkout
 */
export default async function ticketRoute(fastify, options) {
  /**
   * POST /ticket
   * Body: { reference: string }
   * Creates one ticket per item in the reference's ticketTypes array
   */
  fastify.post("/ticket", async (request, reply) => {
    try {
      const { reference } = request.body;

      if (!reference) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Missing required field: reference",
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // ─── Step 1: Verify payment status with retry logic ───────────────────────
      let paymentData = null;
      let attempts = 0;
      const maxAttempts = 3;
      const referenceDocRef = adminDb.collection("Reference").doc(reference);

      while (attempts < maxAttempts) {
        const referenceDoc = await referenceDocRef.get();

        if (!referenceDoc.exists) {
          return reply.code(404).send({
            error: "Not Found",
            message: "Payment reference not found",
            reference,
            developer: "API developed and maintained by Spotix Technologies",
          });
        }

        paymentData = referenceDoc.data();

        if (paymentData.status === "completed") {
          break;
        } else if (paymentData.status === "pending") {
          attempts++;
          if (attempts < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
        } else {
          return reply.code(400).send({
            error: "Bad Request",
            message: `Invalid payment status: ${paymentData.status}`,
            reference,
            developer: "API developed and maintained by Spotix Technologies",
          });
        }
      }

      if (!paymentData || paymentData.status !== "completed") {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Payment still pending after retries",
          reference,
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // ─── Step 2: Expand tickets based on ticketTypes ────────────────────────────
      const ticketTypesArray = paymentData.ticketTypes || [];

      if (!Array.isArray(ticketTypesArray) || ticketTypesArray.length === 0) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "No ticket types found in reference",
          reference,
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      const ticketSeats = [];
      for (const item of ticketTypesArray) {
        const qty = Number(item.quantity) || 1;
        for (let i = 0; i < qty; i++) {
          ticketSeats.push({
            type: item.type,
            price: item.price,
          });
        }
      }

      const totalTicketCount = ticketSeats.length;

      // ─── Step 3: Generate / retrieve all ticket IDs atomically ───────────────
      const now = new Date();
      const purchaseTime = now.toLocaleString("en-US", {
        timeZone: "Africa/Lagos",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });

      let ticketIds = [];
      const createdTicketIds = [];

      const refData = await referenceDocRef.get().then((doc) => doc.data());

      if (refData?.ticketIds) {
        ticketIds = refData.ticketIds;
      } else {
        ticketIds = ticketSeats.map(() => generateTicketId());

        await referenceDocRef.update({
          ticketIds: ticketIds,
        });
      }

      // ─── Step 4: Resolve buyer display data ───────────────────────────────────
      const buyerFullName = paymentData.userFullName || "Valued Customer";
      const buyerEmail = paymentData.userEmail || paymentData.guestEmail || "";
      const buyerPhone = paymentData.userPhone || paymentData.guestPhone || "";
      const isGuest = !paymentData.userId;

      if (!buyerEmail) {
        return reply.code(400).send({
          error: "Bad Request",
          message: "Buyer email not found in reference",
          reference,
          developer: "API developed and maintained by Spotix Technologies",
        });
      }

      // ─── Step 5: Create individual ticket documents ────────────────────────────
      for (let i = 0; i < ticketIds.length; i++) {
        const ticketId = ticketIds[i];
        const seat = ticketSeats[i];

        const ticketDoc = {
          ticketId,
          ticketType: seat.type,
          price: seat.price,
          reference,
          eventId: paymentData.eventId,
          eventName: paymentData.eventName,
          eventCreatorId: paymentData.eventCreatorId,
          buyerFullName,
          buyerEmail,
          buyerPhone,
          userId: paymentData.userId || null,
          isGuest,
          validFrom: new Date().toISOString(),
          status: "active",
          createdAt: now.toISOString(),
          purchaseTime,
        };

        try {
          await adminDb.collection("tickets").doc(ticketId).set(ticketDoc);
        } catch (error) {
          if (error.code === "ALREADY_EXISTS") {
            // Ticket already exists from previous attempt, skip
          }
        }

        // Step 6: Attendee record — events/{eventId}/attendees/{ticketId}
        const attendeeRef = adminDb
          .collection("events")
          .doc(paymentData.eventId)
          .collection("attendees")
          .doc(ticketId);

        const attendeeSnap = await attendeeRef.get();

        if (!attendeeSnap.exists) {
          await attendeeRef.set(ticketDoc);
        } else {
          // Attendee already exists from previous attempt
        }

        createdTicketIds.push(ticketId);
      }

      // ─── Step 7: Atomic operations (stats / discounts) ────────────────────────────
      try {
        const ATOMIC_API_URL = process.env.ATOMIC_API_URL;

        if (ATOMIC_API_URL) {
          // Build a map of ticketType -> first ticketId assigned to that type.
          const typeToFirstTicketId = {};
          for (let i = 0; i < ticketSeats.length; i++) {
            const type = ticketSeats[i].type;
            if (!(type in typeToFirstTicketId)) {
              typeToFirstTicketId[type] = ticketIds[i];
            }
          }

          // Call once per unique ticket type, each with its own idempotency key
          for (const item of ticketTypesArray) {
            const idempotencyKey = typeToFirstTicketId[item.type] || ticketIds[0];
            const atomicResponse = await fetch(ATOMIC_API_URL, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ticketId: idempotencyKey,
                creatorId: paymentData.eventCreatorId,
                eventId: paymentData.eventId,
                ticketType: item.type,
                ticketPrice: item.price,
                quantity: Number(item.quantity) || 1,
                discountCode: paymentData.discountCode || null,
              }),
            });

            if (!atomicResponse.ok) {
              // Non-blocking failure
            }
          }
        }
      } catch (atomicError) {
        // Non-blocking error
      }

      // ─── Step 8: Update referral usage — events/{eventId}/referrals/{code} ────
      if (paymentData.referralCode || paymentData.referralName) {
        try {
          const referralCode = paymentData.referralCode || paymentData.referralName;

          const referralDocRef = adminDb
            .collection("events")
            .doc(paymentData.eventId)
            .collection("referrals")
            .doc(referralCode);

          const referralDoc = await referralDocRef.get();

          if (referralDoc.exists) {
            const usageEntries = createdTicketIds.map((tid, idx) => ({
              name: buyerFullName || "Unknown",
              ticketType: ticketSeats[idx].type,
              ticketId: tid,
              purchaseDate: now,
            }));

            await referralDocRef.update({
              usages: FieldValue.arrayUnion(...usageEntries),
              totalTickets: FieldValue.increment(totalTicketCount),
            });
          }
        } catch (error) {
          // Non-blocking error
        }
      }

      // ─── Step 9: Admin daily sales aggregation ────────────────────────────────
      const purchaseDateFormatted = now.toISOString().split("T")[0];
      const adminSalesRef = adminDb
        .collection("admin")
        .doc("events")
        .collection(paymentData.eventId)
        .doc(purchaseDateFormatted);

      try {
        await adminDb.runTransaction(async (transaction) => {
          const salesDoc = await transaction.get(adminSalesRef);

          if (!salesDoc.exists) {
            transaction.set(adminSalesRef, {
              eventName: paymentData.eventName,
              ticketCount: totalTicketCount,
              ticketSales: paymentData.totalAmount || paymentData.ticketPrice,
              lastPurchaseTime: purchaseTime,
              createdAt: now.toISOString(),
              updatedAt: now.toISOString(),
            });
          } else {
            transaction.update(adminSalesRef, {
              ticketCount: FieldValue.increment(totalTicketCount),
              ticketSales: FieldValue.increment(paymentData.totalAmount || paymentData.ticketPrice),
              lastPurchaseTime: purchaseTime,
              updatedAt: now.toISOString(),
            });
          }
        });
      } catch (error) {
        // Non-blocking error
      }

      // ─── Step 10: Mark reference as fully generated ────────────────────────────
      await referenceDocRef.update({
        ticketGenerated: true,
        ticketGeneratedAt: now.toISOString(),
        generatedTicketIds: createdTicketIds,
        totalTicketsGenerated: totalTicketCount,
        updatedAt: now.toISOString(),
      });

      // ─── Step 11: Global analytics ─────────────────────────────────────────────
      try {
        const ANALYTICS_FUNCTION_URL = process.env.ANALYTICS_FUNCTION_URL;

        if (ANALYTICS_FUNCTION_URL) {
          const analyticsResponse = await fetch(ANALYTICS_FUNCTION_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ticketPrice: paymentData.totalAmount || paymentData.ticketPrice,
              ticketId: createdTicketIds[0],
              ticketCount: totalTicketCount,
              transactionFee: paymentData.transactionFee || 0,
              eventId: paymentData.eventId,
              timestamp: now.toISOString(),
            }),
          });

          if (!analyticsResponse.ok) {
            // Non-blocking failure
          }
        }
      } catch (analyticsError) {
        // Non-blocking error
      }

      // ─── Step 12: Confirmation email (ONLY ONE EMAIL) ──────────────────────────
      // Send only ONE email per order, using the email from reference
      try {
        const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

        const ticketTypeSummary = ticketTypesArray
          .map((item) => `${item.type}${Number(item.quantity) > 1 ? ` x${item.quantity}` : ""}`)
          .join(", ");

        const allTicketIds = createdTicketIds.join(", ");
        const totalAmountForEmail = paymentData.totalAmount || paymentData.ticketPrice || 0;

        const emailPayload = {
          email: buyerEmail,
          name: buyerFullName || "Valued Customer",
          ticket_IDs: allTicketIds,
          ticket_references: reference,
          event_host: paymentData.bookerName || "Event Host",
          event_name: paymentData.eventName,
          payment_ref: reference,
          ticket_types: ticketTypeSummary,
          booker_email: paymentData.bookerEmail || "support@spotix.com.ng",
          total_amount: totalAmountForEmail.toFixed(2),
          ticket_count: totalTicketCount,
          payment_method: "Paystack",
        };

        fastify.log.info("[email] Attempting to send confirmation email...");
        fastify.log.info("[email] Payload:", JSON.stringify(emailPayload, null, 2));
        fastify.log.info(`[email] To: ${buyerEmail}`);
        fastify.log.info(`[email] Name: ${buyerFullName}`);
        fastify.log.info(`[email] Ticket IDs count: ${createdTicketIds.length}`);
        fastify.log.info(`[email] Total amount: ${totalAmountForEmail}`);
        fastify.log.info(`[email] Endpoint: POST ${BACKEND_URL}/v1/mail/payment-confirmation`);

        const emailResponse = await fetch(`${BACKEND_URL}/v1/mail/payment-confirmation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(emailPayload),
        });

        const emailResponseText = await emailResponse.text();
        fastify.log.info(`[email] Response status: ${emailResponse.status}`);
        fastify.log.info(`[email] Response body: ${emailResponseText}`);

        if (emailResponse.ok) {
          fastify.log.info("[email] Email sent successfully");
        } else {
          fastify.log.warn(`[email] Failed to send email — status: ${emailResponse.status}`);
          fastify.log.warn(`[email] Response: ${emailResponseText}`);
        }
      } catch (emailError) {
        fastify.log.error("[email] Error sending confirmation email:", emailError.message);
      }

      // ─── Step 13: Success response ────────────────────────────────────────────
      return reply.code(200).send({
        success: true,
        message: `${totalTicketCount} ticket(s) generated successfully`,
        ticketIds: createdTicketIds,
        ticketReference: reference,
        totalTickets: totalTicketCount,
        eventId: paymentData.eventId,
        eventName: paymentData.eventName,
        totalAmount: paymentData.totalAmount,
        buyerInfo: {
          fullName: buyerFullName,
          email: buyerEmail,
          isGuest,
        },
        eventDetails: {
          eventVenue: paymentData.eventVenue,
          eventType: paymentData.eventType,
          eventDate: paymentData.eventDate,
          eventEndDate: paymentData.eventEndDate,
          eventStart: paymentData.eventStart,
          eventEnd: paymentData.eventEnd,
          bookerName: paymentData.bookerName,
          bookerEmail: paymentData.bookerEmail,
        },
        discountApplied: !!paymentData.discountCode,
        referralUsed: !!paymentData.referralCode,
        developer: "API developed and maintained by Spotix Technologies",
      });
    } catch (error) {
      fastify.log.error("Ticket generation error:", error.message);

      return reply.code(500).send({
        error: "Internal Server Error",
        message: "Failed to generate ticket",
        details: error?.message || String(error),
        developer: "API developed and maintained by Spotix Technologies",
      });
    }
  });

  /**
   * Health check
   */
  fastify.get("/ticket/health", async (request, reply) => {
    return reply.code(200).send({
      status: "healthy",
      service: "Ticket Generation API",
      timestamp: new Date().toISOString(),
      developer: "API developed and maintained by Spotix Technologies",
    });
  });
}

/**
 * Generate unique ticket ID
 * Format: SPTX-TX-{mixed alphanumeric}
 */
function generateTicketId() {
  const randomNumbers = Math.floor(10000000 + Math.random() * 90000000).toString();
  const randomLetters = Math.random().toString(36).substring(2, 4).toUpperCase();

  const pos1 = Math.floor(Math.random() * 8);
  const pos2 = Math.floor(Math.random() * 7) + pos1 + 1;

  const part1 = randomNumbers.substring(0, pos1);
  const part2 = randomNumbers.substring(pos1, pos2);
  const part3 = randomNumbers.substring(pos2);

  return `SPTX-TX-${part1}${randomLetters[0]}${part2}${randomLetters[1]}${part3}`;
}
