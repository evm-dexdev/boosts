import { Config, MAX_FREE_DAILY_MESSAGES } from '../../constants';
import { START_MENU, TelegramService } from '../telegram';
import { UserPrisma } from '../../typings';
import { ApplicationPlatform } from '@repo/database';
import { isTimeOutsideIntervalMs, MILLISECONDS_IN_AN_HOUR } from '@solana-bot/core';
import { GeneralMessages } from '../telegram/messages';

export class UserService {
  constructor(
    private readonly config: Config,
    private readonly telegramService: TelegramService,
  ) {}

  public async getActiveUsers(
    users: NonNullable<UserPrisma>[],
  ): Promise<NonNullable<UserPrisma>[]> {
    const activeUsers: NonNullable<UserPrisma>[] = [];

    for (const user of users) {
      if (this.isPaidSubscriber(user)) {
        activeUsers.push(user);
        continue;
      }

      const dailyMessages = this.getDailyMessageData(user.id);

      if (this.shouldResetDailyLimit(dailyMessages)) {
        await this.resetDailyLimit(user, dailyMessages);
      }

      if (this.hasExceededDailyLimit(dailyMessages)) {
        await this.notifyDailyLimitReached(user, dailyMessages);
        continue;
      }

      this.incrementDailyMessageCount(user.id, dailyMessages);
      activeUsers.push(user);
    }

    return activeUsers;
  }

  public isPaidSubscriber(user: NonNullable<UserPrisma>) {
    return (user.userSubscriptions ?? []).some(
      (sub) => sub.platform === ApplicationPlatform.BOOSTS && sub.plan !== 'FREE',
    );
  }

  private getDailyMessageData(userId: string): { count: number; maxMessagesNotifiedAt?: Date } {
    return this.config.freeDailyMessages.get(userId) || { count: 0 };
  }

  private shouldResetDailyLimit(dailyMessages: {
    count: number;
    maxMessagesNotifiedAt?: Date;
  }): boolean {
    return (
      (dailyMessages.maxMessagesNotifiedAt &&
        isTimeOutsideIntervalMs(
          dailyMessages.maxMessagesNotifiedAt.getTime(),
          MILLISECONDS_IN_AN_HOUR * 6,
        )) ??
      false
    );
  }

  private hasExceededDailyLimit(dailyMessages: {
    count: number;
    maxMessagesNotifiedAt?: Date;
  }): boolean {
    return dailyMessages.count >= MAX_FREE_DAILY_MESSAGES;
  }

  private incrementDailyMessageCount(
    userId: string,
    dailyMessages: { count: number; maxMessagesNotifiedAt?: Date },
  ) {
    dailyMessages.count++;
    this.config.freeDailyMessages.set(userId, dailyMessages);
  }

  private async resetDailyLimit(
    user: NonNullable<UserPrisma>,
    dailyMessages: { count: number; maxMessagesNotifiedAt?: Date },
  ) {
    dailyMessages.count = 0;
    dailyMessages.maxMessagesNotifiedAt = undefined;
    this.config.freeDailyMessages.set(user.id, dailyMessages);

    await this.telegramService.sendMessage(
      Number(user.id),
      'Your daily limits have been resumed.',
      {
        mode: 'HTML',
        disableLinkPreview: true,
      },
    );
  }

  private async notifyDailyLimitReached(
    user: NonNullable<UserPrisma>,
    dailyMessages: { count: number; maxMessagesNotifiedAt?: Date },
  ) {
    if (!dailyMessages.maxMessagesNotifiedAt) {
      dailyMessages.maxMessagesNotifiedAt = new Date();
      this.config.freeDailyMessages.set(user.id, dailyMessages);

      const messageText = GeneralMessages.startMessage(
        user,
        ApplicationPlatform.BOOSTS,
        dailyMessages.count,
      );

      await this.telegramService.sendMessage(Number(user.id), messageText, {
        replyMarkup: START_MENU,
        mode: 'HTML',
      });
    }
  }
}
