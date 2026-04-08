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
          await adminDb.collection("tickets").doc(ticketId).set(ticketDoc);
        } catch (error) {
          if (error.code === "ALREADY_EXISTS") {
            // Ticket already exists from previous attempt, skip
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
          fastify.log.info(`Attendee written to events/${paymentData.eventId}/attendees/${ticketId}`);
        } else {
          fastify.log.info(`Attendee ${ticketId} already exists — skipping`);
        }

        createdTicketIds.push(ticketId);
      }

      // ─── Step 7: Atomic operations (stats / discounts) ────────────────────────
      try {
        const ATOMIC_API_URL = process.env.ATOMIC_API_URL;

        if (ATOMIC_API_URL) {
          fastify.log.info("Calling atomic operations API");

          // Build a map of ticketType -> first ticketId assigned to that type.
          // ticketSeats is expanded in the same order as ticketIds, so we walk
          // them once to find the first index for each unique type.
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
                ticketId: idempotencyKey,           // first ticketId for this ticket type
                creatorId: paymentData.eventCreatorId,
                eventId: paymentData.eventId,
                ticketType: item.type,
                ticketPrice: item.price,
                quantity: Number(item.quantity) || 1,
                discountCode: paymentData.discountCode || null,
              }),
            });

            if (atomicResponse.ok) {
              const atomicResult = await atomicResponse.json();
              if (atomicResult.alreadyProcessed) {
                fastify.log.info(`Atomic ops already processed for type: ${item.type}`);
              } else {
                fastify.log.info(`Atomic ops done for type: ${item.type}`);
              }
            } else {
              fastify.log.warn(`Atomic API returned ${atomicResponse.status} for type ${item.type}`);
            }
          }
        } else {
          fastify.log.warn("ATOMIC_API_URL not configured - skipping atomic operations");
        }
      } catch (atomicError) {
        fastify.log.error("Error calling atomic operations API (non-blocking):", atomicError);
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
            // Record one usage entry per ticket generated
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

            fastify.log.info(`Referral ${referralCode} updated with ${totalTicketCount} ticket(s)`);
          }
        } catch (error) {
          fastify.log.error("Error updating referral (non-blocking):", error);
        }
      }

      // ─── Step 9: Admin daily sales aggregation (unchanged path, quantity-aware) ─
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
            fastify.log.info(`Created daily sales record for ${purchaseDateFormatted}`);
          } else {
            transaction.update(adminSalesRef, {
              ticketCount: FieldValue.increment(totalTicketCount),
              ticketSales: FieldValue.increment(paymentData.totalAmount || paymentData.ticketPrice),
              lastPurchaseTime: purchaseTime,
              updatedAt: now.toISOString(),
            });
            fastify.log.info(`Updated daily sales record for ${purchaseDateFormatted}`);
          }
        });
      } catch (error) {
        fastify.log.error("Error updating daily sales aggregation (non-blocking):", error);
      }

      // ─── Step 10: Mark reference as fully generated ────────────────────────────
      await referenceDocRef.update({
        ticketGenerated: true,
        ticketGeneratedAt: now.toISOString(),
        generatedTicketIds: createdTicketIds,   // all IDs written in this run
        totalTicketsGenerated: totalTicketCount,
        updatedAt: now.toISOString(),
      });

      fastify.log.info(`Reference ${reference} marked complete — ${totalTicketCount} ticket(s) generated`);

      // ─── Step 11: Global analytics ───────────────────────────────���────────────
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

          if (analyticsResponse.ok) {
            const analyticsResult = await analyticsResponse.json();
            if (analyticsResult.alreadyProcessed) {
              fastify.log.info(`Analytics already processed for reference ${reference}`);
            } else {
              fastify.log.info("Analytics updated successfully");
            }
          } else {
            fastify.log.warn("Failed to update analytics — tickets still created");
          }
        } else {
          fastify.log.warn("ANALYTICS_FUNCTION_URL not configured — skipping analytics");
        }
      } catch (analyticsError) {
        fastify.log.error("Error updating analytics (non-blocking):", analyticsError);
      }

      // ─── Step 12: Confirmation email ──────────────────────────────────────────────
      try {
        const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:5000";

        // Summarise all ticket types purchased for the email
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

        fastify.log.info("[email] Payload being sent to mail service:");
        fastify.log.info(JSON.stringify(emailPayload, null, 2));
        fastify.log.info(`[email] Endpoint: ${BACKEND_URL}/v1/mail/payment-confirmation`);
        fastify.log.info(`[email] buyerEmail resolved to: "${buyerEmail}"`);
        fastify.log.info(`[email] buyerFullName resolved to: "${buyerFullName}"`);
        fastify.log.info(`[email] ticketTypesArray at email time: ${JSON.stringify(ticketTypesArray)}`);
        fastify.log.info(`[email] createdTicketIds: ${JSON.stringify(createdTicketIds)}`);
        fastify.log.info(`[email] totalTicketCount: ${totalTicketCount}`);
        fastify.log.info(`[email] totalAmount on paymentData: ${paymentData.totalAmount}`);
        fastify.log.info(`[email] ticketPrice on paymentData: ${paymentData.ticketPrice}`);

        const emailResponse = await fetch(`${BACKEND_URL}/v1/mail/payment-confirmation`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(emailPayload),
        });

        if (emailResponse.ok) {
          fastify.log.info("[email] Confirmation email sent successfully");
        } else {
          const errorText = await emailResponse.text().catch(() => "(could not read body)");
          fastify.log.warn(`[email] Failed — status: ${emailResponse.status}, body: ${errorText}`);
        }
      } catch (error) {
        fastify.log.error("[email] Error sending confirmation email (non-blocking):", error);
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
      fastify.log.error("Ticket generation error:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
      fastify.log.error("Error message:", error?.message);
      fastify.log.error("Error stack:", error?.stack);

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
