import {
  ApiV3PoolInfoItem,
  ApiV3Token,
  publicKey,
  Raydium,
  seq,
  struct,
  u128,
  u64,
  WSOLMint,
} from '@raydium-io/raydium-sdk-v2';
import { logger } from '@repo/logger';
import { PrismaUserRepository } from '@repo/database/repositories';
import { ApplicationPlatform } from '@repo/database';
import { getTokenAccountBalance, getTokenMktCap, sleep } from '@solana-bot/core';
import { IScheduledTask } from './schedule.interface';
import { Config } from '../../../constants';
import {
  dexScreenerService,
  TelegramService,
  BoostsMessages,
  createTxSubMenu,
  UserService,
} from '../../../services';
import { IDexScreenerLatestBoostedTokens } from '../../../typings';
import { DexScreenerCache, IBoostedTokensCache } from '../../../cache';
import { PublicKey } from '@solana/web3.js';

export type ApiV3PoolInfoItemWithMarketCap = ApiV3PoolInfoItem & {
  marketCap?: number;
  mintTokenInfo: ApiV3Token;
};

export const MINIMAL_MARKET_STATE_LAYOUT_V3 = struct([
  u64('status'),
  u64('nonce'),
  u64('maxOrder'),
  u64('depth'),
  u64('baseDecimal'),
  u64('quoteDecimal'),
  u64('state'),
  u64('resetFlag'),
  u64('minSize'),
  u64('volMaxCutRatio'),
  u64('amountWaveRatio'),
  u64('baseLotSize'),
  u64('quoteLotSize'),
  u64('minPriceMultiplier'),
  u64('maxPriceMultiplier'),
  u64('systemDecimalsValue'),
  u64('minSeparateNumerator'),
  u64('minSeparateDenominator'),
  u64('tradeFeeNumerator'),
  u64('tradeFeeDenominator'),
  u64('pnlNumerator'),
  u64('pnlDenominator'),
  u64('swapFeeNumerator'),
  u64('swapFeeDenominator'),
  // OutPutData
  u64('baseNeedTakePnl'),
  u64('quoteNeedTakePnl'),
  u64('quoteTotalPnl'),
  u64('baseTotalPnl'),
  u64('poolOpenTime'),
  u64('punishPcAmount'),
  u64('punishCoinAmount'),
  u64('orderbookToInitTime'),
  u128('swapBaseInAmount'),
  u128('swapQuoteOutAmount'),
  u64('swapQuote2BaseFee'),
  u128('swapQuoteInAmount'),
  u128('swapBaseOutAmount'),
  u64('swapBase2QuoteFee'),

  publicKey('baseVault'),
  publicKey('quoteVault'),
  publicKey('baseMint'),
  publicKey('quoteMint'),
  publicKey('lpMint'),

  publicKey('openOrders'),
  publicKey('marketId'),
  publicKey('marketProgramId'),
  publicKey('targetOrders'),
  publicKey('withdrawQueue'),
  publicKey('lpVault'),
  publicKey('owner'),
  u128('lpReserve'),
  seq(u64(), 64, 'padding'),
]);

export class BoostsSchedule implements IScheduledTask {
  private readonly userService: UserService;
  public readonly cronExpression: string = '*/15 * * * * *';

  constructor(
    private readonly config: Config,
    private readonly raydium: Raydium,
    private readonly dexScreenerCache: DexScreenerCache,
    private readonly prismaUserRepository: PrismaUserRepository,
    private readonly telegramService: TelegramService,
  ) {
    this.userService = new UserService(this.config, this.telegramService);
  }

  public async executeTask(): Promise<void> {
    try {
      const boostedTokens = await dexScreenerService.getLatestBoostedTokens();

      for (const boostedToken of boostedTokens) {
        await this.processBoostedToken(boostedToken);
        await sleep(1000);
      }
    } catch (error) {
      logger.error(error);
    }
  }

  private async processBoostedToken(boostedToken: IDexScreenerLatestBoostedTokens) {
    const cachedBoost = this.dexScreenerCache.get(boostedToken.tokenAddress);

    if (!this.shouldProcessToken(boostedToken, cachedBoost)) {
      return;
    }

    const poolInfo = await this.getPoolInfo(boostedToken);

    if (cachedBoost) {
      this.updateCachedBoost(boostedToken);
    } else {
      this.createNewBoostedToken(boostedToken, poolInfo);
    }

    const users = await this.prismaUserRepository.getAllWithPlatform(ApplicationPlatform.BOOSTS);
    const activeUsers = await this.userService.getActiveUsers(users);

    for (const user of activeUsers) {
      const TX_SUB_MENU = createTxSubMenu(
        poolInfo?.mintTokenInfo.symbol ?? '',
        boostedToken.tokenAddress,
      );

      this.telegramService
        .sendMessage(Number(user.id), BoostsMessages.boostMessage(boostedToken, poolInfo), {
          mode: 'HTML',
          disableLinkPreview: true,
          replyMarkup: TX_SUB_MENU,
        })
        .then(() =>
          logger.info(
            `[Boosts] ${boostedToken.tokenAddress} was been notified for user ${user.id}!`,
          ),
        )
        .catch((error: unknown) =>
          logger.error('[Boosts] error sending boosts message!', { error }),
        );
    }
  }

  private shouldProcessToken(
    boostedToken: IDexScreenerLatestBoostedTokens,
    cachedBoost?: IBoostedTokensCache,
  ): boolean {
    return (
      boostedToken.totalAmount - (cachedBoost?.totalAmount ?? 0) >= 100 &&
      boostedToken.amount >= 100 &&
      boostedToken.chainId === 'solana'
    );
  }

  private async getPoolInfo(
    boostedToken: IDexScreenerLatestBoostedTokens,
  ): Promise<ApiV3PoolInfoItemWithMarketCap | undefined> {
    try {
      const poolData = (
        await this.raydium.api.fetchPoolByMints({
          mint1: boostedToken.tokenAddress,
        })
      ).data[0];

      if (poolData?.id) {
        const lpAccount = await this.config.connection.getAccountInfo(new PublicKey(poolData.id));

        if (lpAccount) {
          const decodedAccount = MINIMAL_MARKET_STATE_LAYOUT_V3.decode(lpAccount.data);

          const baseAmount = (
            await getTokenAccountBalance(this.config.connection, decodedAccount.baseVault)
          )?.value.uiAmount;
          const quoteAmount = (
            await getTokenAccountBalance(this.config.connection, decodedAccount.quoteVault)
          )?.value.uiAmount;

          if (!baseAmount || !quoteAmount) {
            return;
          }

          const isMintANative = poolData.mintA.address === WSOLMint.toString();

          const priceInSol = isMintANative ? baseAmount / quoteAmount : quoteAmount / baseAmount;
          const priceInUsdc = priceInSol * this.config.solanaUsdcPrice;
          const marketCap = await getTokenMktCap(
            this.config.connection,
            priceInUsdc,
            boostedToken.tokenAddress,
          );

          return {
            ...poolData,
            marketCap,
            mintTokenInfo: isMintANative ? poolData.mintA : poolData.mintB,
          };
        }
      }
    } catch {
      logger.error('Error getting pool id/supply for mint!', {
        mint: boostedToken.tokenAddress,
      });
    }
  }

  private updateCachedBoost(boostedToken: IDexScreenerLatestBoostedTokens) {
    const updateData: Partial<IBoostedTokensCache> = {
      amount: boostedToken.amount,
      totalAmount: boostedToken.totalAmount,
      updatedAt: Date.now(),
    };

    this.dexScreenerCache.update(boostedToken.tokenAddress, updateData);
  }

  private createNewBoostedToken(
    boostedToken: IDexScreenerLatestBoostedTokens,
    poolInfo: ApiV3PoolInfoItemWithMarketCap | undefined,
  ) {
    const createData: Omit<IBoostedTokensCache, 'id'> = {
      ...boostedToken,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.dexScreenerCache.save(boostedToken.tokenAddress, {
      ...createData,
      marketCap: poolInfo?.marketCap,
    });
  }
}
