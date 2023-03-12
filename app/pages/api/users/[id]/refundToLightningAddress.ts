import { WithdrawalFlow, WithdrawalMethod } from "@prisma/client";
import { LightningAddress } from "alby-tools";
import { StatusCodes } from "http-status-codes";
import { createNotification } from "lib/createNotification";
import { payWithdrawalInvoice } from "lib/payWithdrawalInvoice";
import prisma from "lib/prismadb";
import { getWithdrawableTipsQuery } from "lib/withdrawal";
import { withErrorMessage } from "lib/withErrorMessage";
import type { NextApiRequest, NextApiResponse } from "next";
import { ErrorResponse } from "types/ErrorResponse";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<never | ErrorResponse>
) {
  const { id } = req.query;
  if (req.method !== "POST") {
    return res.status(StatusCodes.NOT_FOUND).end();
  }

  const { apiKey } = req.query;
  const validApiKey = !!(process.env.API_KEY && apiKey === process.env.API_KEY);
  if (!validApiKey) {
    return res.status(StatusCodes.UNAUTHORIZED).end();
  }

  const user = await prisma.user.findUnique({
    where: {
      id: id as string,
    },
  });
  if (!user) {
    return res.status(StatusCodes.NOT_FOUND).end();
  }
  if (!user.lightningAddress) {
    return res.status(StatusCodes.NOT_FOUND).end();
  }

  const withdrawalFlow: WithdrawalFlow = "tipper";
  const withdrawalMethod: WithdrawalMethod = "lightning_address";

  const tips = await prisma.tip.findMany({
    where: getWithdrawableTipsQuery(withdrawalFlow, user.id, undefined),
    include: {
      tipper: true,
    },
  });

  if (!tips.length) {
    const errorMessage = "No tips are available to withdraw";
    throw new Error(errorMessage);
  }

  const amount = tips.map((tip) => tip.amount).reduce((a, b) => a + b);

  let invoice: string | undefined;

  try {
    invoice = await createLnurlPayInvoice(user.lightningAddress, amount);
    if (!invoice) {
      throw new Error(
        "No lnurlPay invoice created for lightning address " +
          user.lightningAddress
      );
    }

    await payWithdrawalInvoice(
      withdrawalFlow,
      invoice,
      user.id,
      undefined,
      withdrawalMethod,
      undefined
    );

    try {
      await createNotification(user.id, "AUTOMATIC_REFUND", undefined);
    } catch (error) {
      console.error(
        "Failed to create automatic refund to lightning address notification",
        error
      );
    }

    return res.status(StatusCodes.NO_CONTENT).end();
  } catch (error) {
    const errorMessage =
      "Failed to execute withdrawal to lightning address for user " +
      user.id +
      ": " +
      JSON.stringify(error, Object.getOwnPropertyNames(error));

    console.error(errorMessage, error);

    await prisma.withdrawalError.create({
      data: {
        message: errorMessage,
        userId: user.id,
        withdrawalFlow,
        withdrawalMethod,
        withdrawalInvoice: invoice,
      },
    });

    return withErrorMessage(
      res.status(StatusCodes.INTERNAL_SERVER_ERROR),
      (error as Error).message
    );
  }
}

async function createLnurlPayInvoice(lightningAddress: string, amount: number) {
  const ln = new LightningAddress(lightningAddress, { proxy: "" });

  // fetch the LNURL data
  await ln.fetch();

  const invoice = (
    await ln.requestInvoice({
      satoshi: amount,
      comment: "Lightsats reclaimed sats",
    })
  ).paymentRequest;
  return invoice;
}
